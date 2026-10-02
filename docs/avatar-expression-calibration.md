# Avatar Expression Capability and Calibration

## Scope

This change audits and controls the existing facial geometry. It does not add genuine ARKit shapes, rewrite rigs, record faces, change providers, or make per-turn LLM calls. Source VRM/GLB files remain unchanged. The original model licenses continue to apply.

The workflow is inspired by [vrm-expression-agent-harness](https://github.com/shinshin86/vrm-expression-agent-harness): inspect first, preserve the source, distinguish supported and approximate shapes, test combinations, and leave visual review explicit. No runtime code from that repository is included.

## Current Asset Findings

| Asset | ARKit names | Effective names | Independent groups, summed per mesh |
| --- | ---: | ---: | ---: |
| John Do ARKit | 52 | 38 | 18 |
| Streamoji | 52 | 52 | 64 |
| Haru | 0 | 0 | 0 (native VRM presets remain available) |

The John Do file is a local proxy mapping, not a successful VRoidShaper conversion. Its historical generation report records 38 proxy names sourced from 18 existing morphs and 14 zero placeholders. For example, both brow-down names share one shape; jawOpen and mouthFunnel also share a shape. Do not interpret this as 52 independent facial controls.

Streamoji's count exceeds 52 groups because the same semantic target can move several meshes. A zero mouth target on an eye mesh does not invalidate the head or teeth targets. Geometry being nonzero does not prove anatomical or semantic accuracy, left/right correctness, or a safe maximum intensity.

## Runtime Ownership

1. Inspect all vertices at load time, supporting both relative and absolute morph attributes. Reject non-finite or malformed targets. Do not infer capability from names alone.
2. Group exactly identical position AND normal deltas on each mesh, including original VRM aliases. Hashing only narrows candidates; exact comparison decides equality.
3. Keep native VRM fallback for missing expression, blink, or viseme capabilities. A plain GLB needs no VRM expression manager.
4. Run the VRM update first. Apply calibrated raw morph weights afterwards so the VRM manager cannot reintroduce alias contributions later in the frame.
5. For one physical shape, use the maximum requested alias weight, not their sum; clear the other aliases including originals. Separate meshes remain independently driven.
6. During speech, visemes own the mouth, including cue gaps. Brow/eye emotion remains; blinking attenuates conflicting eye-wide/squint weights. Mouth scale and jaw caps still use the loaded asset's existing lip profile, including after asset fallback.
7. Smooth each independent shape with bounded, time-based damping. Speech cancellation clears non-emotional mouth movement; brow/eye release remains smooth.

Existing safe seated poses, body animation, gaze, Google audio, Rhubarb timestamps and barge-in lifecycle are not replaced. The existing profile numbers are engineering limits, not visually certified calibration values.

## Instructor Preview

Open `/instructor`, select **Avatar & Voice**, and use **Expression Lab**. The 12-second sequence runs listening, guarded, downcast, repair, and return phases. Use the intensity slider and optional silent viseme overlay. Stop, changing avatar, or leaving the page ends the preview. It neither writes session turns nor requests STT/TTS/LLM services.

The silent overlay uses a synthetic playback clock to exercise mouth composition; it is NOT proof of real audio synchronization. Live interview playback still uses its real audio clock. Debug lists the actual loaded asset, effective targets, shared shapes and unsupported controls. Haru remains a preset-expression fallback. Preview controls are inside the existing instructor role boundary.

## Repeatable Verification

```sh
npm run avatar:expression:audit
npm run avatar:expression:runtime:test
npm run avatar:expression:test
npm run avatar:motion:test
npm run avatar:lip:test
npm run avatar:streamoji:test
npm run build
```

Audit output is local/ignored at `data/evaluations/avatar-expression-capabilities.json`, with asset SHA-256 and per-mesh capability details. Missing or malformed assets fail explicitly. Run after replacing any model. The runtime independently inspects the actually loaded geometry, so it does not trust a stale report.

Optional browser verification (Playwright and Sharp are test-only dependencies, not production dependencies):

```sh
npm run avatar:expression:browser:test
```

When using externally installed test dependencies, set `PLAYWRIGHT_MODULE` and `SHARP_MODULE` to their absolute entrypoints. The test starts and stops an ephemeral preview, intercepts all API calls, checks all three models for nonblank canvas output, tests sequence completion/cancellation, and saves desktop screenshots to `/tmp/social-work-expression-check`. It requires installed desktop Chrome. It does not perform paid calls.

## Acceptance Boundaries

- Automated geometry tests cover localized/zero/invalid/absolute deltas, alias ownership, multi-mesh isolation, frame-rate-independent damping, cancellation, reset, and a 720-frame composite replay for every model.
- Browser checks cover model visibility, preview interaction and desktop layout. Screenshots are not facial naturalness validation.
- Before shipping new calibration values, compare each model at low/medium intensity with blink and real audio, including barge-in and return to baseline. Check mouth closure, eyes, teeth, asymmetry and emotional readability. Record asset hash and reviewer outcome; do not mark an unreviewed asset approved.
- Existing John Do aliases cannot be made independently left/right by changing weights. Real new geometry would require a separate source-preserving, license-checked asset-authoring task.
- No deploy, model overwrite or paid evaluation is part of these commands.
