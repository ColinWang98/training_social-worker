console.log(`
Cloud voice manual check
========================

Target: ${process.env.CLOUD_HEALTH_URL ?? 'https://training-social-worker.fly.dev'}

1. Open the app and sign in with Basic Auth.
2. Switch to instructor mode and confirm /api/health shows ADK, Google voice, Rhubarb, and corpus as ready or clearly degraded.
3. Enable voice mode and speak 3-5 Cantonese turns without closing the microphone.
4. While the avatar is speaking, say "等一下" and confirm TTS stops and the new utterance becomes the next student turn.
5. Check avatar behavior:
   - "你好 / 好吧 / 啊" should only trigger low-intensity idle mix.
   - "哈哈哈哈" should trigger defensive reaction.
   - John Do lip-sync should remain aligned.
   - Streamoji mouth should return to rest at the end.

This script does not call DeepSeek, Google STT/TTS, or the deployed app.
`);
