// The hidden picture-search page (served as swembed://ort/embedder-page.js, after ort.webgpu.min.js).
// It owns ONNX Runtime Web and runs EmbeddingGemma 2 on WebGPU. It has no Node access: model files
// come from swembed://ort/model/…, and commands arrive through `host`, the only thing the sandboxed,
// context-isolated preload (src/preload/embedder.ts) exposes. Inputs arrive already prepared.
/* global ort, host */
'use strict'
;(() => {
  let vision = null
  let text = null
  const T = (type, dims, data) => new ort.Tensor(type, data, dims)
  const bytes = async (path) => new Uint8Array(await (await fetch(`swembed://ort/model/${path}`)).arrayBuffer())

  async function open(name) {
    const [model, data] = await Promise.all([bytes(`onnx/${name}.onnx`), bytes(`onnx/${name}.onnx_data`)])
    return ort.InferenceSession.create(model, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      externalData: [{ path: `${name}.onnx_data`, data }]
    })
  }

  function normalise(v) {
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i] * v[i]
    const n = Math.sqrt(s) || 1
    for (let i = 0; i < v.length; i++) v[i] /= n
    return v
  }

  async function runText(ids, imageFeatures) {
    if (!text) throw new Error('text model not loaded')
    const n = ids.length
    const empty = () => T('float32', [0, 512], new Float32Array(0))
    const out = await text.run({
      input_ids: T('int64', [1, n], BigInt64Array.from(ids, (x) => BigInt(x))),
      attention_mask: T('int64', [1, n], new BigInt64Array(n).fill(1n)),
      image_features: imageFeatures || empty(),
      video_features: empty(),
      audio_features: empty()
    })
    return normalise(Float32Array.from(await out.sentence_embedding.getData()))
  }

  const commands = {
    async info() {
      const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null
      return { webgpu: Boolean(a), f16: Boolean(a && a.features.has('shader-f16')) }
    },
    async load({ withVision }) {
      const t0 = performance.now()
      if (!text) text = await open('model_fp16')
      if (withVision && !vision) vision = await open('vision_encoder_fp16')
      return { seconds: (performance.now() - t0) / 1000, vision: Boolean(vision) }
    },
    async unloadVision() {
      if (vision) await vision.release()
      vision = null
      return true
    },
    async text({ ids }) {
      return runText(ids)
    },
    async image({ pv, dims, pos, posDims, ids }) {
      if (!vision) throw new Error('vision model not loaded')
      const v = await vision.run({ pixel_values: T('float32', dims, pv), pixel_position_ids: T('int64', posDims, pos) })
      return runText(ids, v.image_features)
    }
  }

  host.onCmd(async (id, name, payload) => {
    try {
      const fn = commands[name]
      if (!fn) throw new Error(`unknown command ${name}`)
      host.reply(id, { ok: true, value: await fn(payload) })
    } catch (e) {
      host.reply(id, { ok: false, error: String((e && e.message) || e) })
    }
  })

  try {
    if (typeof ort === 'undefined') throw new Error('onnxruntime-web did not load')
    ort.env.wasm.wasmPaths = 'swembed://ort/'
    ort.env.wasm.numThreads = 1
    ort.env.logLevel = 'error'
    host.ready({ ok: true })
  } catch (e) {
    host.ready({ ok: false, error: String((e && e.message) || e) })
  }
})()
