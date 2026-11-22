# Application messages

Both peers exchange JSON strings on the existing reliable ordered data channel. The envelope uses `protocol: "slipstream-app"`, numeric `version: 1`, and a string `type`. The local channel determines the sender's role. Unknown types, invalid fields and unsupported versions are ignored. Messages belong only to the current peer connection.

| Type | Sender | Additional fields |
| --- | --- | --- |
| `device-name` | Either | `name` is a trimmed, nonempty string of up to 32 UTF-16 code units without control or format characters. |

Legacy chat and Phase 2 transfer controls retain their own routing. Application messages never carry binary file data or travel through PHP.
