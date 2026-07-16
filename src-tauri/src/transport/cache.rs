//! Keymap-cache persistence.
//!
//! The whole RPC sync result is serialized to JSON by the frontend and stored in
//! the app data dir. Modeled on zmk-studio/src-tauri/src/backup.rs's plain
//! read/write style, but pinned to a single fixed file inside app_data_dir (the
//! frontend never chooses the path), so there is no arbitrary-path surface here.

use std::fs;
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager};

const CACHE_FILE: &str = "keymap-cache.json";

/// Resolve `<app_data_dir>/keymap-cache.json`, creating the dir if missing.
fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir を解決できません: {e}"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("app data dir を作成できません: {e}"))?;
    }
    Ok(dir.join(CACHE_FILE))
}

/// Write the serialized keymap cache, overwriting any existing file.
#[command]
pub fn cache_write(app: AppHandle, contents: String) -> Result<(), String> {
    let path = cache_path(&app)?;
    fs::write(&path, contents).map_err(|e| format!("キャッシュ書き込みに失敗: {e}"))
}

/// Read the cache file. Returns `None` when it does not exist yet.
#[command]
pub fn cache_read(app: AppHandle) -> Result<Option<String>, String> {
    let path = cache_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("キャッシュ読み込みに失敗: {e}"))
}
