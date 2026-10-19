# Phase 0 hash-checked tool installer guard

## Command

```sh
node --test tests/install-tools.test.mjs
```

## Recorded result

```text
20 passed
```

The offline tests exercise one valid manual HTTPS redirect, redirect-to-HTTP rejection, missing and malformed locations, redirect loops, the three-redirect limit, final-URL validation, response-size bounds, stored and deflated ZIP extraction from a local fixture including deflate compression-option flag `0x0002`, rejection of `0x0002`/`0x0004` on stored entries, executable-bit parsing and safe-mode extraction, tar.gz extraction from a deterministic fixture, GNU TAR long-name metadata, safe relative symlinks, SHA-256 verification before decompression/extraction, refusal of an `UNKNOWN` lock entry, and ZIP/TAR path and collision rejection. TAR tests cover checksum and end-record validation, bounded entry sizes, hardlink/device/FIFO/special metadata rejection, symlink-cycle/target safety, and the tar.xz parser through an injected decompressor seam. A separate opt-in Windows host run also passed a real tar.xz fixture through the fixed local `xz` executable and the same TAR extractor. The verifier also rejects insecure remote URLs, duplicate or unsafe ZIP paths, ZIP symlinks and special files, encrypted or unsupported entries, ZIP64, oversized archives, and bounded-limit violations.

Remote artifact fetches use direct manual fetch calls, a three-hop HTTPS-only redirect bound, a per-request timeout, and the existing bounded response-body reader. The real pinned Godot Windows/Linux-Docker runs are recorded in `godot-win32.json` and `godot-linux-docker.json`; the real uv Windows/Linux-Docker binary smokes are recorded in `uv-win32.json` and `uv-linux-docker.json`; and the real Blender Windows/Linux-Docker background smokes are recorded in `blender-win32.json` and `blender-linux-docker.json`. All successful runs matched their lock SHA-256 before parsing/extraction; executable bits were preserved for Unix binaries. The default 128 MiB per-entry bound remains unchanged and was recorded as `ZIP_SIZE_LIMIT` on the first Windows Godot local CLI attempt.

## Scope boundary

This is primarily an installer safety boundary. uv is qualified only for the measured Windows x64 and Linux x64 Docker binary smokes; Blender is qualified only for the measured Windows x64 and Linux x64 Docker background smokes; ffmpeg and remaining profiles stay unqualified. The pinned Godot editor fixture smoke is scoped to Windows x64 and Linux x64 Docker in `godot-win32.json` and `godot-linux-docker.json`. Stored/deflated ZIP, tar.gz, and the bounded real tar.xz Blender extraction are demonstrated; tar.xz runtime support remains conditional on a local `xz` executable, and no other production tool or profile qualification is claimed. ZIP64, multi-volume, encrypted, unsupported ZIP flags, and other unsupported formats fail visibly.
