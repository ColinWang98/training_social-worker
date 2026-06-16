# Avatar Clip Attribution

This folder stores local prototype VRMA candidates and runtime manifests.

## xlunar-ai-avatar candidates

- Source: https://github.com/iamenahs/xlunar-ai-avatar
- Candidate files: `public/animations/*.vrma`
- Project license: MIT License, copyright VaultX.Technology
- Important: upstream VRMA files include third-party credits. Preserve the source and credit notes before reuse outside this local prototype.

Known upstream animation credits listed by `xlunar-ai-avatar`:

- VRoid Project Motion Pack: free, credit required. Required attribution: `Character animation credits to pixiv Inc.'s VRoid Project`.
- vrm-viewer animations: MIT License, tk256ailab.
- vrma-loader-sample: MIT License, tfuru.
- three-vrm test animation: MIT License, pixiv Inc.

Runtime policy in this project:

- Raw downloaded VRMA files are kept in `_incoming/`.
- Runtime selection must only use manifest entries with `playbackMask: "upper_body"` and `seatedRuntime: true`.
- Lower body remains controlled by the local seated pose controller.
