//! 「GATT のサービス／キャラクタリスティックが見つからない」からの自動回復。
//!
//! ファームウェアを更新するとサービスのハンドル配置が変わることがあり、ホスト
//! (Windows) 側に残った GATT の記憶が陳腐化して、実在するサービスまで見つから
//! なくなる。2026-08-14 に実際に起きていて、そのときは Bluetooth 設定からキー
//! ボードを削除して再ペアリングするまで復旧しなかった。
//!
//! bluest の Windows 実装では `discover_services_with_uuid` /
//! `discover_characteristics_with_uuid` が既に `BluetoothCacheMode::Uncached`
//! を使っている (windows/device.rs, windows/service.rs) ので、「キャッシュを無
//! 視して読み直す」API はこれ以上ない。残る手は二つで、どちらも本モジュールに
//! ある:
//!
//!   1. UUID で絞り込まない全列挙 (`discover_services` /
//!      `discover_characteristics`)。WinRT では GetGattServicesForUuid… と
//!      GetGattServices… は別の呼び出しで、ハンドルが動いた後は前者だけが空を
//!      返すことがある。→ [`enumerate`]
//!   2. `BluetoothLEDevice` を開き直す。bluest の Windows 実装では Device と
//!      その子オブジェクトが生きている間だけ接続と GATT セッションが保たれる
//!      (windows/adapter.rs の `disconnect_device` の注釈を参照) ので、古いハン
//!      ドルを全部手放してから開き直すと探索がやり直される。ハンドルを本当に
//!      全部落とせるのは接続経路 (gatt.rs) だけなので、そちらに置いてある。
//!
//! やり直しは各所 1 回きり。接続と切断を繰り返すループは作らない。

use std::time::Duration;

use bluest::{Characteristic, Device};
use uuid::Uuid;

/// 短いリトライの回数と間隔。接続直後の Windows は GATT テーブルがまだ用意でき
/// ていないことが多く、最初の一回はよく失敗する (元は各所に散っていた 350ms×6)。
const ATTEMPTS: u8 = 6;
const RETRY_DELAY: Duration = Duration::from_millis(350);

/// 回復を試みても駄目だったときにフロントへ返す案内。App.tsx は `gatt_connect` /
/// `live_feed_subscribe` の Err をそのまま `setError(String(e))` で表示するので、
/// ここに書いた文面がそのままユーザーに届く。
pub const REPAIR_HINT: &str = "キーボードのサービスが見つかりません。ファームウェア更新後の場合は、Windows の Bluetooth 設定でキーボードを削除し、再ペアリングしてください。";

/// 探しものの UUID と、ログ／エラーメッセージ用の呼び名。
pub struct Target {
    /// ログの接頭辞 ("gatt" / "live_feed" / "diag")。
    pub tag: &'static str,
    pub svc_uuid: Uuid,
    /// サービスが無いときの言い回し。呼び出し側ごとに意味が違う (studio RPC の
    /// 不在と live_feed の不在は原因が別物) ので文面ごと持たせる。
    pub svc_missing: &'static str,
    pub chrc_uuid: Uuid,
    pub chrc_missing: &'static str,
}

/// 対象のキャラクタリスティックを探す。
///
/// 通常の探索を 350ms 間隔で最大 6 回、それでも駄目なら UUID 絞り込みなしの
/// 全列挙を 1 回だけ試す。Err の中身は最後に見えた低レベルの理由で、ユーザー
/// 向けの文面 ([`REPAIR_HINT`]) を添えるのは呼び出し側の仕事。
pub async fn discover_characteristic(t: &Target, device: &Device) -> Result<Characteristic, String> {
    let mut attempt = 0u8;
    let last = loop {
        attempt += 1;
        match by_uuid(t, device).await {
            Ok(found) => return Ok(found),
            Err(e) => {
                if attempt >= ATTEMPTS {
                    break e;
                }
                eprintln!("[{}] discovery attempt {} failed: {}; retrying", t.tag, attempt, e);
                async_std::task::sleep(RETRY_DELAY).await;
            }
        }
    };

    eprintln!(
        "[{}] discovery failed after {} attempts: {}; re-enumerating the whole GATT table",
        t.tag, ATTEMPTS, last
    );
    match enumerate(t, device).await {
        Ok(found) => {
            eprintln!("[{}] found by full re-enumeration", t.tag);
            Ok(found)
        }
        Err(e) => Err(format!("{} / {}", last, e)),
    }
}

/// 通常経路。UUID で絞り込んだ探索 (Windows 実装では Uncached)。
async fn by_uuid(t: &Target, device: &Device) -> Result<Characteristic, String> {
    let service = device
        .discover_services_with_uuid(t.svc_uuid)
        .await
        .map_err(|e| format!("discovering services: {}", e.message()))?
        .into_iter()
        .next()
        .ok_or_else(|| t.svc_missing.to_string())?;

    service
        .discover_characteristics_with_uuid(t.chrc_uuid)
        .await
        .map_err(|e| format!("discovering characteristics: {}", e.message()))?
        .into_iter()
        .next()
        .ok_or_else(|| t.chrc_missing.to_string())
}

/// 回復経路。UUID で絞り込まずに全部列挙してから自分で選ぶ。
///
/// WinRT では GetGattServices… と GetGattServicesForUuid… は別の呼び出しで、
/// ハンドルが動いた後は後者だけが空を返すことがある。どちらも Uncached なので
/// 「実機から読み直す」点は同じだが、通ってくる経路が違うぶん拾えることがある。
pub async fn enumerate(t: &Target, device: &Device) -> Result<Characteristic, String> {
    let service = device
        .discover_services()
        .await
        .map_err(|e| format!("re-enumerating services: {}", e.message()))?
        .into_iter()
        .find(|s| s.uuid() == t.svc_uuid)
        .ok_or_else(|| format!("{} (full re-enumeration)", t.svc_missing))?;

    service
        .discover_characteristics()
        .await
        .map_err(|e| format!("re-enumerating characteristics: {}", e.message()))?
        .into_iter()
        .find(|c| c.uuid() == t.chrc_uuid)
        .ok_or_else(|| format!("{} (full re-enumeration)", t.chrc_missing))
}
