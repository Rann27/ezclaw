import type { Mode } from "@ezclaw/core";
import { ChatTextIcon, type Icon, ImageIcon, PaintBrushIcon, TerminalWindowIcon } from "@phosphor-icons/react";

export interface ModeInfo {
  mode: Mode;
  label: string;
  icon: Icon;
  milestone: string;
  /** What the mode will do once its milestone lands. */
  plan: string;
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  chat: {
    mode: "chat",
    label: "Chat",
    icon: ChatTextIcon,
    milestone: "M1",
    plan: "Chat tersambung ke endpoint yang kamu tambahkan di Settings, dengan jawaban streaming, blok reasoning, lampiran, dan panel parameter yang mengikuti model.",
  },
  agent: {
    mode: "agent",
    label: "Agent",
    icon: TerminalWindowIcon,
    milestone: "M2",
    plan: "Agent bekerja di folder project: membaca dan mengubah file, menjalankan perintah, dan selalu meminta izin sesuai mode approval yang kamu pilih.",
  },
  image: {
    mode: "image",
    label: "Image",
    icon: ImageIcon,
    milestone: "M3",
    plan: "Generate gambar dari prompt dan gambar referensi, lalu ubah hasilnya lewat percakapan. Prompt yang dikirim ke model selalu ditampilkan.",
  },
  edit: {
    mode: "edit",
    label: "Edit",
    icon: PaintBrushIcon,
    milestone: "M4",
    plan: "Satu gambar target, beberapa referensi dengan peran yang jelas, versi berantai, dan perbandingan sebelum dan sesudah.",
  },
};

const LAST_MODE_KEY = "ezclaw.lastMode";

export function readLastMode(): Mode {
  try {
    const value = localStorage.getItem(LAST_MODE_KEY);
    return value && value in MODE_INFO ? (value as Mode) : "chat";
  } catch {
    return "chat";
  }
}

export function writeLastMode(mode: Mode) {
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    // Not critical: the app just opens Chat next time.
  }
}
