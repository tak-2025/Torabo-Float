// Adapted from zmk-studio/src/keyboard/HidUsageLabel.tsx.
//
// Studio switched short/med/long labels via Tailwind container-query variants.
// Float keys are a fixed size (oneU = 48px), so we drop the container query and
// render the medium label directly (falling back to short), which is faithful at
// this key size and needs no Tailwind.
import {
  hid_usage_get_labels,
  hid_usage_page_and_id_from_usage,
} from "../hid-usages";

export interface HidUsageLabelProps {
  hid_usage: number;
}

function remove_prefix(s?: string) {
  return s?.replace(/^Keyboard /, "");
}

export const HidUsageLabel = ({ hid_usage }: HidUsageLabelProps) => {
  let [page, id] = hid_usage_page_and_id_from_usage(hid_usage);

  // TODO: Do something with implicit mods!
  page &= 0xff;

  const labels = hid_usage_get_labels(page, id);
  const text = remove_prefix(labels.med || labels.short) || "";

  return <span className="hid-label">{text}</span>;
};
