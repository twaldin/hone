import { readFileSync, writeSync } from "node:fs";
import { MetaCampaignConfigV2 } from "@hone/schema";
import {
  MetaJournalV1,
  type MetaEnvelopeRequestV1,
  type MetaPendingChildInputV1,
  type MetaWorkIdentityV1,
} from "../../src/meta-journal.js";

interface PendingReplayFixture {
  configPath: string;
  journalPath: string;
  identity: MetaWorkIdentityV1;
  envelope: MetaEnvelopeRequestV1;
  pending: MetaPendingChildInputV1;
}

const encoded = process.env["HONE_PENDING_REPLAY_FIXTURE"];
if (encoded === undefined) throw new Error("HONE_PENDING_REPLAY_FIXTURE is required");
const fixture = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PendingReplayFixture;
const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(fixture.configPath, "utf8")));
const journal = MetaJournalV1.open(fixture.journalPath, config);
journal.reserveChild(fixture.identity, fixture.envelope);
journal.recordChildPending(fixture.identity, fixture.pending);
writeSync(1, "PENDING-REPLAYED\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
