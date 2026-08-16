import { existsSync } from "node:fs";
import { MemoryError, ErrorCodes } from "../errors.ts";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.ts";

/**
 * 真本地 ONNX 模型。本期权重可选；路径缺失不得声称 onnx 成功。
 */
export class OnnxEmbedding implements EmbeddingProvider {
  readonly id = "onnx";
  readonly dims: number;
  private readonly modelPath: string;

  constructor(cfg: EmbeddingConfig) {
    this.modelPath = cfg.onnx_model_path?.trim() ?? "";
    this.dims = cfg.dims ?? 384;
    if (!this.modelPath || !existsSync(this.modelPath)) {
      throw new MemoryError(
        ErrorCodes.DISABLED,
        this.modelPath
          ? `onnx 权重不存在: ${this.modelPath}`
          : "embedding.provider=onnx 需要 onnx_model_path",
      );
    }
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new MemoryError(
      ErrorCodes.DISABLED,
      `onnx 权重已找到但本期未实现推理: ${this.modelPath}`,
    );
  }
}

export function onnxWeightsPresent(cfg: EmbeddingConfig): boolean {
  const p = cfg.onnx_model_path?.trim() ?? "";
  return p.length > 0 && existsSync(p);
}
