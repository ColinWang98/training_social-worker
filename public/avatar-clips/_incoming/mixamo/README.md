# Mixamo Manual Incoming Clips

Put manually downloaded Mixamo animation files here for local review.

Recommended Mixamo export settings:

- Format: FBX Binary or Collada (`.dae`)
- Skin: Without Skin
- Frames: 30 FPS
- Pose/motion: In Place when available
- Content: seated, talking, listening, thinking, looking around, subtle hand/upper-body motions

Runtime policy:

- Raw Mixamo files in this folder are never auto-loaded by the interview runtime.
- Register files with `npm run mixamo:register -- --file public/avatar-clips/_incoming/mixamo/<file> --family reflective --label "Subtle thinking"`.
- Registration writes `manifest.local.json` in this folder. That file is ignored and only for local review.
- Validate with `npm run mixamo:validate`.
- A Mixamo clip can only be promoted manually after it is converted or constrained to upper-body seated motion.
