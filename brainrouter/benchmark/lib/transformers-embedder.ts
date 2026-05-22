import { pipeline } from "@xenova/transformers";

export class TransformersEmbedder {
  private extractor: any;
  private ready: boolean = false;
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.init();
  }

  private async init() {
    // using all-MiniLM-L6-v2 by default
    this.extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    this.ready = true;
  }

  isReady() {
    return this.ready;
  }

  getDimensions() {
    return 384;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.ready) {
      await this.initPromise;
    }
    const result = await this.extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(result.data);
  }
}
