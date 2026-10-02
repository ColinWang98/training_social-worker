# Third-Party Architecture References

This project independently implements its realtime voice transport and does not bundle Hugging Face speech models or the `speech-to-speech` runtime.

The event lifecycle, AudioWorklet queueing, interruption, and transport separation were informed by the Hugging Face `speech-to-speech` project and its realtime demo, distributed under the Apache License 2.0:

- https://github.com/huggingface/speech-to-speech
- https://github.com/huggingface/speech-to-speech/tree/main/demo

No Hugging Face model weights are included in the production image. Existing dependency licenses remain governed by their own package notices and license files.
