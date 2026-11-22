# Phase 2 transfer integration

The starting revision was `staging` at `0fbbb39`. Pairing, SDP/ICE exchange and the ordered data channel worked. Both browsers then threw constructor errors in the channel-open callbacks.

| Starting behavior | Repair |
| --- | --- |
| The UI passed options to channel-first constructors, then called missing `start` and `destroy` methods. | Each role creates one protocol engine when the channel opens and disposes it on disconnect. |
| The peer and engines each installed message handlers. A later control could overtake asynchronous Blob conversion. | The peer dispatches messages once in arrival order. The UI routes controls to its local role, binary chunks to the receiver, and legacy chat to the chat handler. |
| Offers carried flat metadata. The UI could display an incoming offer before the engine validated it. | The receiver checks the v1 envelope, UUID, nested metadata and size limit before exposing Accept. |
| The sender counted queued bytes and completed immediately after sending the last chunk. The receiver emitted `file-verified`. | The sender displays receiver-reported progress and waits for `file-complete-ack` with verified status, matching size and digest. |
| The receiver checked aggregate length. The old buffer thresholds and control messages differed from the contract. | The receiver checks each expected chunk length and both final counts. The sender pauses above 1 MiB and resumes at 256 KiB. Cancellation and the 60-second deadlines clean up pending work. |

## Reproduce the protocol tests

From the repository root with Node.js 22 or newer:

```sh
node --test qa/transfer.test.cjs
```

The suite runs the shipped classic scripts with paired mock channels. It covers zero bytes, each side of the 16 KiB boundary, a multi-megabyte file, accept/decline, cancellation, peer close, malformed input, corruption, progress cadence, back-pressure, timeouts, invalid acknowledgments, repeated transfers and legacy chat.

## Browser verification

Two Chrome tabs on one Windows computer used the local PHP router and MySQL signaling database. The host generated a code, the joiner opened its join URL, and a Phase 1 chat message arrived. In that session the receiver declined an offer, cancelled a later 10 MiB transfer during receipt, then accepted the following repository fixtures. Both UIs completed, the sender received the verified acknowledgment, and the downloaded bytes matched each source.

| Fixture in `qa/fixtures/` | Downloaded SHA-256 |
| --- | --- |
| `test_1mb.bin` | `fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83` |
| `test_16385b.bin` | `0000baf2684790c1122339755831010d032e896ce376a38e20106fcdd0a5517c` |
| `test_0b.bin` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Closing the receiver tab during another transfer put the sender in the failed state. Separate physical devices and mobile browsers remain pending. To repeat manually, start the configured local server with `php -S 127.0.0.1:8000 router.php`, open the host at `http://127.0.0.1:8000`, follow its join URL in a second tab, and compare each downloaded file with the corresponding entry in `qa/fixtures/sha256sums.txt`.

The web image proposed in PR #7 explicitly lists browser files. Include `js/transfer-protocol.js` in its Docker build context and public JavaScript directory when integrating the two branches.
