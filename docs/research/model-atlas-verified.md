# Model Atlas verification record

**Review date:** 2026-10-20  
**Scope:** every row in `docs/pack/04_FORGE_AND_MODEL_ATLAS.md §11`  
**Method:** offline repository review only. No network, hosted key, GPU, or
Owner hardware qualification run was available. Consequently, no real model is
called qualified here. `ASSUMED` means the row remains a pack hypothesis or
conservative fallback, not a verified license, quality, hardware, or commercial
suitability claim. `DISPROVED` is reserved for a measured or primary-source
rejection.

| Atlas row | Status | Source / limit | Ledger ID |
|---|---|---|---|
| Small local models (Gemma 4 E-class, Qwen3.5-class ≤9B) | ASSUMED | Pack hypothesis only: no primary source or local run was available for current names, memory claims, or game-director suitability. | `ledger:phase2:atlas:reasoning-small-assumed` |
| Mid models (gpt-oss-20b, Devstral Small 2, Qwen3.x 27B-class) | ASSUMED | Pack hypothesis only; no measured memory requirement on the reference machine. | `ledger:phase2:atlas:reasoning-mid-assumed` |
| BYOK frontier reasoning (Anthropic, OpenAI, Google, DeepSeek/Qwen via OpenRouter) | ASSUMED | Hosted route remains a design fallback; vendor/API shapes, terms, price, and routing were not verified in this offline session. | `ledger:phase2:atlas:reasoning-hosted-assumed` |
| Qwen-VL family small sizes | ASSUMED | Candidate perception route; no primary model card or VRAM qualification captured. | `ledger:phase2:atlas:vision-qwenvl-assumed` |
| Gemma 4 multimodal small, MiniCPM-V, Moondream, SmolVLM | ASSUMED | Family-level pack hypothesis; no model/version/license verification. | `ledger:phase2:atlas:vision-small-assumed` |
| Florence-2 | ASSUMED | Candidate OCR/detection route; no primary source or CPU/OCR measurement captured. | `ledger:phase2:atlas:florence2-assumed` |
| PaddleOCR / Tesseract | ASSUMED | Candidate OCR route; current intended versions and integration claims are not verified. | `ledger:phase2:atlas:ocr-assumed` |
| SAM-class / OWL / Grounding-DINO | ASSUMED | Candidate segmentation/detection route; licenses and reference-hardware behavior require per-model research. | `ledger:phase2:atlas:detection-segmentation-assumed` |
| Text embeddings: bge, Qwen3-Embedding, EmbeddingGemma, nomic | ASSUMED | Candidate retrieval route; model cards, licenses, and commercial restrictions were not captured. | `ledger:phase2:atlas:text-embeddings-assumed` |
| Image embeddings: SigLIP2 / OpenCLIP / DINOv2 | ASSUMED | Candidate style route; no versioned license or measured reference profile. | `ledger:phase2:atlas:image-embeddings-assumed` |
| Hosted vision (Claude/GPT/Gemini) | ASSUMED | Candidate hosted fallback; no live API contract or price source used. | `ledger:phase2:atlas:hosted-vision-assumed` |
| FLUX.2 [klein] 4B | ASSUMED | Pack candidate only: Apache-2.0, ComfyUI support, 4 GB behavior, and weak text rendering were not independently verified; no qualification claim. | `ledger:phase2:atlas:flux2-klein-assumed` |
| Z-Image Turbo | ASSUMED | Candidate image route; license and ~4 GB claim remain unverified; no qualification claim. | `ledger:phase2:atlas:z-image-assumed` |
| SD 1.5 / SDXL and add-ons | ASSUMED | Candidate ecosystem; each checkpoint/LoRA/ControlNet requires its own license and hardware record. | `ledger:phase2:atlas:sd-ecosystem-assumed` |
| FLUX.1-dev/Kontext, Qwen-Image(-Edit), HiDream, Chroma | ASSUMED | Candidate image routes; quality, size, and license vary by version; no adoption decision. | `ledger:phase2:atlas:image-large-assumed` |
| Hosted image vendors (BFL, Gemini, OpenAI, Ideogram, Recraft, Seedream, Scenario, PixelLab) | ASSUMED | Hosted candidates only; no ≥3-vendor comparison or current API/price verification was performed. | `ledger:phase2:atlas:hosted-image-assumed` |
| Real-ESRGAN / 4x-UltraSharp / SwinIR / SUPIR | ASSUMED | Candidate upscale routes; model/checkpoint licenses and measured local behavior remain open. | `ledger:phase2:atlas:upscale-assumed` |
| BiRefNet / RMBG-2.0 / SAM-class | ASSUMED | Candidate background-removal routes; per-checkpoint license and model version are required. | `ledger:phase2:atlas:bgremove-assumed` |
| Poly Haven / ambientCG | ASSUMED | Library-first candidates; current asset terms and retrieval API behavior were not checked. | `ledger:phase2:atlas:material-libraries-assumed` |
| Seamless texture / PBR workflows, DeepBump / ArmorLab / Marigold | ASSUMED | Workflow candidates; quality and licenses require fixture/primary-source research. | `ledger:phase2:atlas:texture-workflows-assumed` |
| TRELLIS.2 | ASSUMED | Candidate 3D route; MIT, 24 GB+ claim, ComfyUI nodes, and PBR behavior were not independently verified. | `ledger:phase2:atlas:trellis2-assumed` |
| Hunyuan3D 2.1 | ASSUMED | Candidate 3D route; Tencent license terms and low-VRAM forks require primary-source review. | `ledger:phase2:atlas:hunyuan3d-assumed` |
| Hi3DGen / Stable Fast 3D / TripoSR | ASSUMED | Candidate 3D routes; licenses and reference-hardware behavior vary by project/version. | `ledger:phase2:atlas:fast3d-assumed` |
| Hosted 3D (Meshy, Tripo, Hyper3D Rodin, Sloyd, fal/Replicate) | ASSUMED | Hosted candidates only; no vendor comparison, API shape, or price verification. | `ledger:phase2:atlas:hosted-3d-assumed` |
| Blender post-processing / glTF toolchain | ASSUMED | Required Phase 6 pipeline; exact pinned versions and qualification remain open. | `ledger:phase2:atlas:mesh-postprocess-assumed` |
| Library-first animation / Mixamo / Blender retargeting | ASSUMED | Candidate animation route; terms and add-on versions require per-source research. | `ledger:phase2:atlas:animation-library-assumed` |
| UniRig / Tripo / Meshy rigging | ASSUMED | Candidate rigging routes; service/model terms and output quality are not measured. | `ledger:phase2:atlas:rigging-assumed` |
| Generative motion / MediaPipe / WHAM-class | ASSUMED | Candidate motion routes; research models and licenses are not captured. | `ledger:phase2:atlas:motion-assumed` |
| ACE-Step 1.5 | ASSUMED | Candidate music route; MIT, <4 GB claim, and loop/stem suitability remain hypotheses; no music run. | `ledger:phase2:atlas:ace-step-assumed` |
| Stable Audio Open / AudioLDM2 / MMAudio | ASSUMED | Candidate audio routes; current licenses and local behavior are not captured. | `ledger:phase2:atlas:audio-generation-assumed` |
| MusicGen | ASSUMED | `docs/pack/04_FORGE_AND_MODEL_ATLAS.md §11.7` labels weights CC-BY-NC; the restriction is retained as a conservative assumption pending a primary license record. | `ledger:phase2:atlas:musicgen-assumed-nc` |
| Hosted audio/music/TTS (ElevenLabs, Lyria, Stability) | ASSUMED | Hosted candidates only; no vendor/API/price research or live call. | `ledger:phase2:atlas:hosted-audio-assumed` |
| Freesound API | ASSUMED | Library candidate; per-clip license handling and API contract are not captured. | `ledger:phase2:atlas:freesound-assumed` |
| Kokoro / Chatterbox / Orpheus / Dia / XTTS-v2 / F5-TTS / Piper | ASSUMED | Candidate TTS routes; licenses, weights, and CPU behavior vary by version. | `ledger:phase2:atlas:tts-assumed` |
| whisper.cpp / faster-whisper | ASSUMED | Candidate STT routes; versioned license and measured WER/CPU profile are not captured. | `ledger:phase2:atlas:stt-assumed` |
| Demucs-class stems | ASSUMED | Candidate stem routes; current weights/license and local behavior are not captured. | `ledger:phase2:atlas:stems-assumed` |
| Rhubarb visemes | ASSUMED | Candidate lipsync route; versioned terms and integration contract are not captured. | `ledger:phase2:atlas:lipsync-assumed` |
| Local video models (Wan, LTX, CogVideoX, HunyuanVideo) | ASSUMED | Candidate video routes; practical 4 GB limit remains a pack hypothesis, not a measured result. | `ledger:phase2:atlas:video-local-assumed` |
| Hosted video (Veo, Sora, Kling, Runway, Luma, fal/Replicate) | ASSUMED | Hosted candidates only; no vendor/API/price research or live call. | `ledger:phase2:atlas:video-hosted-assumed` |
| llama.cpp / Ollama / LM Studio / vLLM | ASSUMED | Candidate runtimes; exact current versions, multimodal support, and JSON-schema decoding were not tested. | `ledger:phase2:atlas:llm-runtimes-assumed` |
| ComfyUI / stable-diffusion.cpp / whisper.cpp / ffmpeg | ASSUMED | Candidate runtimes; exact versions, flags, and API contracts remain open. | `ledger:phase2:atlas:creative-runtimes-assumed` |
| fal.ai / Replicate / Hugging Face Inference Providers / OpenRouter | ASSUMED | Hosted aggregators only; current API contracts and pricing were not checked. | `ledger:phase2:atlas:aggregators-assumed` |

The row-level keys above are sub-record labels under Research Ledger entry
`R-014`; they are intentionally not claims that a vendor source was verified.

## Current implementation boundary

The checked-in `catalog/` contains only deterministic mock/fixture records. They
exercise catalog loading/linting and are not evidence for any real model's
license, quality, VRAM, latency, or qualification. A future verification session
must replace `ASSUMED` only with primary URLs, retrieval dates, and a
Ledger record; a future hardware run must bind any `QUALIFIED` status to its
machine profile and measured harness output.
