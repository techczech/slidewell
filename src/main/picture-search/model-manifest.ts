/**
 * The picture-search model, pinned: EmbeddingGemma 2, ONNX fp16 (text + vision only; the audio
 * encoder is never downloaded). Every file is fetched from one fixed Hugging Face revision and
 * checked against the sha256 + byte size recorded here, so a download either matches these bytes
 * exactly or is thrown away. Engine choice and spike numbers: SlideWell _TASK-LOG/RESUME.md
 * (semantic search line) and the learning-log entry it cites.
 */

export const MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'
export const MODEL_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
/** Folder name under <userData>/models/. Changing the pinned files means a new folder name. */
export const MODEL_DIR_NAME = 'embeddinggemma-2-onnx-fp16'
export const MODEL_DIM = 768
/** Query prompt the model was trained with (documents/images take no prompt). */
export const QUERY_PREFIX = 'task: search result | query: '

export type ModelFile = { path: string; size: number; sha256: string }

export const MODEL_FILES: readonly ModelFile[] = [
  { path: 'tokenizer_config.json', size: 1599, sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874' },
  { path: 'processor_config.json', size: 1788, sha256: '168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c' },
  { path: 'tokenizer.json', size: 32170510, sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4' },
  { path: 'onnx/model_fp16.onnx', size: 425780, sha256: 'a49e227d7e0e5f4ee606d79879d084264366367bc6318f344ab179e35d4fd6a4' },
  { path: 'onnx/model_fp16.onnx_data', size: 542085120, sha256: 'b9dbe09415d77c8686ba6e216a244086f4ada1608238c13f2bfaa587ba627207' },
  { path: 'onnx/vision_encoder_fp16.onnx', size: 112253, sha256: '3e2b6d5648a3ae61b572cc3ec0a23b13ebfda3b63e3c9c343c593636392a879c' },
  { path: 'onnx/vision_encoder_fp16.onnx_data', size: 335513088, sha256: '9f374070808b8b96252f7d04c9c4eae34df60283473fde5a3fbf4d9205495e19' }
]

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((s, f) => s + f.size, 0)

export function modelFileUrl(path: string): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${path}`
}

/** Session file names inside onnx/ (graph + external weights), as the embedder window loads them. */
export const TEXT_SESSION = 'model_fp16'
export const VISION_SESSION = 'vision_encoder_fp16'
