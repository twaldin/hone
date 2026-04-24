# Social drafts — hone haiku launch

Review + pick one when you wake up. All written to Tim's voice (lowercase titles, numbers-forward, no slop).

## HN title options (pick one)

All under 80 chars, all concrete.

1. `i lifted claude haiku 4.5 from 65% to 85% on unseen github bugs for $1`
2. `$1 of sonnet tokens lifted haiku 4.5 by 20 percentage points on unseen bugs`
3. `using a claude max subscription as a prompt optimizer to hone haiku +20pp`
4. `GEPA + claude cli subscriptions as a prompt optimizer: haiku 65% → 85%`

Recommend #1 — concrete, numbers-forward, cheap-thing-big-result hook that HN likes.

## HN self-text (for "Show HN" format)

```
tl;dr i ran GEPA on claude haiku 4.5 against 20 real github bug-fix challenges,
then tested the discovered prompt on 9 held-out challenges it never saw. Same
model, same bugs, system-prompt-only change: 65% → 85% solve rate on unseen
bugs (+20 absolute pp). ~$1 in sonnet mutator tokens on my claude max sub, no
API keys needed. Full writeup + the honed prompt text:
https://tim.waldin.net/blog/2026-04-19-hone-haiku-20pp

hone wraps GEPA with a CLI-first interface and uses claude code / codex /
opencode / gemini subscriptions as the mutation engine instead of paid API
keys. that's the novel bit. code: https://github.com/twaldin/hone

caveat: strong models saturate. i tried the same setup on gpt-5.4 earlier and
got zero lift — the seed prompt (`minimal correct fix`) already matches what
gpt-5.4 does internally. the lift is biggest on weaker models. running seed
evals on gpt-5.4-mini and gemini-2.5-flash right now to find the next
goldilocks candidate.

happy to answer questions on methodology or the honed prompt itself.
```

## Tweet thread — 3 tweets

Open one OK-quality thread, not 10 shallow ones.

**Tweet 1 (hook):**
```
spent $1 of sonnet tokens moving claude haiku 4.5 from 65% → 85% solve rate
on 9 github bugs it had never seen before.

same model, same bugs, only the system prompt changed. GEPA ran on my claude
max subscription — no API keys needed.

writeup: https://tim.waldin.net/blog/2026-04-19-hone-haiku-20pp
```

**Tweet 2 (the prompt):**
```
the honed prompt isn't clever. it's basically "don't stop after the first
failing test passes. check every failure, fix every location, iterate until
the full suite is green."

haiku's known failure mode is stopping early. GEPA found that and patched it.

full honed text in the writeup ↑
```

**Tweet 3 (the caveat + what's next):**
```
caveat: strong models saturate. i got zero lift on gpt-5.4 earlier because
the bare seed already matches what it does internally. the lift is biggest
on weaker models with room to grow.

running seed evals on gpt-5.4-mini + gemini-2.5-flash now to find the next
goldilocks candidate.
```

## Twitter posting cadence (recommended)

- **Sunday 10-11am EST** — post HN self-text + tweet thread 1
- **Sunday 2-4pm EST** — if tweet thread gets traction, reply with the honed prompt as an image or a screenshot (adds visual interest). If no traction, skip.
- **Do not post again Sunday unless there's a concrete reason.** Over-posting dilutes.
- **Monday morning** — if HN hit, write one follow-up tweet with the leaderboard position / engagement numbers / something concrete. Otherwise skip.

## What NOT to post

- Don't split hone and agentelo into two separate threads. agentelo is the testbed; mention it in tweet 1 or the HN body and link. Two brands in one week muddies the signal.
- Don't post "launching hone today!!" — you already posted the hone repo publicly. The story is the RESULT, not the launch.
- Don't respond to every comment. Pick 3-5 interesting questions and give real answers. Ignore the noise.
