import type { EvalAdapter } from "./types.ts";

/** HaluMem 走 publish runner（halumem-run.ts）；此处仅占位 registry。 */
export const halumemAdapter: EvalAdapter = {
  id: "halumem",
  async load() {
    throw new Error("HaluMem 请用 memory eval --adapter halumem [--fixture]；不走 capture 子串路径");
  },
  score() {
    return 0;
  },
};
