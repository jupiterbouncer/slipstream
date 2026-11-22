# Application messages

Both peers exchange JSON strings on the existing reliable ordered data channel. The envelope uses `protocol: "slipstream-app"`, numeric `version: 1`, and a string `type`. The local channel determines the sender's role. Unknown types, invalid fields and unsupported versions are ignored. Messages belong only to the current peer connection.

| Type | Sender | Additional fields |
| --- | --- | --- |
| `device-name` | Either | `name` is a trimmed, nonempty string of up to 32 UTF-16 code units without control or format characters. |
| `share-text` | Either | `text` contains 1–8192 UTF-8 bytes, including at least one non-whitespace character. Content is shown literally. Only an entire HTTP(S) URL gets an explicit open action. |

Legacy chat and Phase 2 transfer controls retain their own routing. Application messages never carry binary file data or travel through PHP.
