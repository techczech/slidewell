/**
 * Preload for the hidden picture-search window (never shown, never loads remote content). The page
 * (swembed://ort/embedder.html) only loads ONNX Runtime Web; this script drives it: it reads the
 * verified model files from disk, runs the vision encoder and text model on WebGPU, and answers
 * the main process over IPC. Inputs arrive already prepared (pixels, position ids, token ids).
 * contextIsolation is off for this window only, so this script can reach the page's `ort` global.
 */
import { ipcRenderer } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, any>>; release(): Promise<void> }
type Ort = {
  env: { wasm: { wasmPaths?: string; numThreads?: number }; logLevel?: string }
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown
  InferenceSession: { create(model: Uint8Array, opts: Record<string, unknown>): Promise<Session> }
}

// The page's globals, typed locally (this file is checked with the node tsconfig, which has no DOM lib).
const page = globalThis as unknown as {
  ort?: Ort
  navigator: { gpu?: { requestAdapter(): Promise<any> } }
  addEventListener(type: string, cb: () => void): void
}

// Node's hook for WebAssembly.instantiateStreaming (present because this preload runs with Node)
// aborts the renderer on a custom-protocol Response. Compile from bytes instead; same result.
const wasm = (globalThis as unknown as { WebAssembly: unknown }).WebAssembly as {
  instantiate(bytes: ArrayBuffer, imports?: unknown): Promise<unknown>
  instantiateStreaming?: (r: unknown, imports?: unknown) => Promise<unknown>
  compileStreaming?: unknown
}
wasm.instantiateStreaming = async (r, imports) => wasm.instantiate(await (await (r as Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>)).arrayBuffer(), imports)
wasm.compileStreaming = undefined

let vision: Session | null = null
let text: Session | null = null

const ort = (): Ort => {
  const o = page.ort
  if (!o) throw new Error('onnxruntime-web did not load')
  return o
}
const T = (type: string, dims: number[], data: unknown): unknown => new (ort().Tensor)(type, data, dims)
const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

async function open(dir: string, name: string): Promise<Session> {
  const model = u8(readFileSync(join(dir, 'onnx', `${name}.onnx`)))
  const data = u8(readFileSync(join(dir, 'onnx', `${name}.onnx_data`)))
  return ort().InferenceSession.create(model, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: `${name}.onnx_data`, data }]
  })
}

function normalise(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

async function runText(ids: Int32Array, imageFeatures?: unknown): Promise<Float32Array> {
  if (!text) throw new Error('text model not loaded')
  const n = ids.length
  const empty = (): unknown => T('float32', [0, 512], new Float32Array(0))
  const out = await text.run({
    input_ids: T('int64', [1, n], BigInt64Array.from(ids, (x) => BigInt(x))),
    attention_mask: T('int64', [1, n], new BigInt64Array(n).fill(1n)),
    image_features: imageFeatures ?? empty(),
    video_features: empty(),
    audio_features: empty()
  })
  return normalise(Float32Array.from(await out.sentence_embedding.getData()))
}

const commands: Record<string, (p: any) => Promise<unknown>> = {
  async info() {
    const gpu = page.navigator.gpu
    const a = gpu ? await gpu.requestAdapter() : null
    return { webgpu: Boolean(a), f16: Boolean(a?.features?.has('shader-f16')), arch: a?.info?.architecture ?? '' }
  },
  async load({ dir, withVision }: { dir: string; withVision: boolean }) {
    const t0 = performance.now()
    if (!text) text = await open(dir, 'model_fp16')
    if (withVision && !vision) vision = await open(dir, 'vision_encoder_fp16')
    return { seconds: (performance.now() - t0) / 1000, vision: Boolean(vision) }
  },
  async unloadVision() {
    if (vision) await vision.release()
    vision = null
    return true
  },
  async text({ ids }: { ids: Int32Array }) {
    return runText(ids)
  },
  async image({ pv, dims, pos, posDims, ids }: { pv: Float32Array; dims: number[]; pos: BigInt64Array; posDims: number[]; ids: Int32Array }) {
    if (!vision) throw new Error('vision model not loaded')
    const v = await vision.run({ pixel_values: T('float32', dims, pv), pixel_position_ids: T('int64', posDims, pos) })
    return runText(ids, v.image_features)
  }
}

ipcRenderer.on('embedder:cmd', async (_e, id: number, name: string, payload: unknown) => {
  try {
    const fn = commands[name]
    if (!fn) throw new Error(`unknown command ${name}`)
    ipcRenderer.send('embedder:reply', id, { ok: true, value: await fn(payload) })
  } catch (e) {
    ipcRenderer.send('embedder:reply', id, { ok: false, error: String((e as Error)?.message ?? e) })
  }
})

page.addEventListener('DOMContentLoaded', () => {
  try {
    const o = ort()
    o.env.wasm.wasmPaths = 'swembed://ort/'
    o.env.wasm.numThreads = 1
    o.env.logLevel = 'error'
    ipcRenderer.send('embedder:ready', { ok: true })
  } catch (e) {
    ipcRenderer.send('embedder:ready', { ok: false, error: String((e as Error)?.message ?? e) })
  }
})
