# Submission: Fly.io Hacksgiving 2026

Material for the Last Orders entry. Submissions close before midnight PST on Sunday
29 November 2026 (21:00 NZDT, Monday 30 November 2026).

The rule: "Your project must be an agent that runs on Fly.io Sprites using at least one
connector." Last Orders meets it like this. The agent runs on the Sprite `last-orders-gm`. It
calls Claude through the Sprites Anthropic connector. Real replies through the connector were
measured on 26 November 2026.

| Item | Value |
|---|---|
| Play link | https://last-orders.fly.dev |
| Code | https://github.com/BevanR/last-orders |
| Demo video | Add the link after upload. |
| Social post | Tag @flydotio. Drafts below. |

**No spoilers anywhere.** The repository, the video and the posts are public, and players will
read them. Do not name the killer, the solution or the decisive evidence. The demo script
below avoids all three.

## (a) Short description (149 words)

Last Orders is a browser murder mystery for one to six friends. A storm has cut off a New
Zealand lodge, and its owner lies dead at the foot of the cellar stairs. Claude plays the four
suspects and an AI game master. Players search six rooms, question each suspect in private, pin
evidence to a shared board, and show cards to break a suspect's story. A rules engine
owns the facts. It decides what each suspect knows, when their testimony changes, and how the
accusation scores. Claude gives the suspects their voices, so the case stays fair and the killer
never confesses. The game is a Fly App with Fly Managed Postgres. The agent runs on a Fly
Sprite that wakes when a reply is needed and sleeps when the room is quiet. It calls Claude
through the Sprites Anthropic connector, so the Sprite holds no API key.

## (b) Longer description (396 words)

Last Orders is a murder mystery you play in a browser with friends. Helen Marsh held her
retirement dinner tonight, and a storm has cut the only road out of her lodge. At ten past ten she was found at the foot of her cellar stairs. Four people sat at
that dinner or cooked it. Every one of them is hiding something. Only one of them is hiding a
killing.

One to six people play together. The host opens a case and sends an invite link. Players search
six rooms for exhibit cards, which stay private until someone pins them to the shared board.
Each player questions the suspects in private.
Claude speaks for each suspect. When a player shows a suspect a card that contradicts their
story, the suspect's testimony moves on and Claude voices the new account. An AI game master
watches the room about every 90 seconds. When the group stalls, it gives an authored hint,
points at a room nobody has searched, or plays a storm event. The game runs in three acts and
ends with one group accusation, a reveal, and a short commentary from Claude.

The design rule is that the rules engine owns the facts and the model owns the voice. Every
change of testimony is an authored transition. The app runs it inside a database transaction
with a unique key, so it fires exactly once. Each suspect's prompt holds only what that suspect knows and may say. The killer's
prompt never states what the killer did, and every prompt forbids a confession. The solution never
reaches a browser before the reveal; an end-to-end test checks the pages and API responses for
it.

The app is a Fly App backed by Fly Managed Postgres. It owns all state and the job queue. The
agent runs on a Fly Sprite. When a job waits, the app sends the Sprite an empty `POST /wake`. The
agent claims jobs over an authenticated internal API, calls Claude through the Sprites Anthropic
connector, and submits results. The Sprite holds no API key and no game state, so it can sleep
or restart without harm.

We measured it on 26 November 2026. A warm suspect reply took 2.9 s. A reply after 16 minutes
idle took 60.6 s, most of it Sprite boot. The test suite runs with a simulated model and makes
no paid calls.

## (c) Social posts

Each is under 280 characters, tags @flydotio, and has the play link and the repository link.

**Post 1 (1 emoji)**

> Claude plays all four suspects in our murder mystery. Search the lodge, question them in
> private, show them the evidence. The agent sleeps on a @flydotio Sprite until someone asks. 🔎
> Play: https://last-orders.fly.dev
> Code: https://github.com/BevanR/last-orders

**Post 2 (no emoji)**

> Last Orders: four suspects played by Claude, one killer who won't confess. A rules engine
> owns the facts; Claude owns the voice. Its agent runs on a @flydotio Sprite and calls Claude
> through the Sprites connector.
> https://last-orders.fly.dev
> https://github.com/BevanR/last-orders

Paste each as one post, with the line breaks shown. Character counts are in the checklist.

## (d) Demo script (2 minutes 45 seconds)

### Before you record

1. **Warm the Sprite.** A cold Sprite took 60.6 s to give its first reply on 26 November 2026,
   and once about 4 minutes. Do one of these 1 to 5 minutes before you record:
   - Create a room in the lobby. The app sends a pre-warm ping at once.
   - Or run `curl -m 300 https://last-orders-gm-bu5ng.sprites.app/healthz` and wait for
     `{"ok":true,...}`.

   If you stop for more than about 10 minutes, warm it again. We know the idle limit is under
   15 minutes; we did not measure it exactly.
2. **Use a fresh room for the take.** Each game has a US$3 model spend cap. A long rehearsal
   room can reach it, and then replies show "simulated". Before you record, open "Behind the
   scenes" (the slider icon, top right) and check that replies count as "live model".
3. **Two browsers side by side.** Browser A is the host, "Hana". Browser B is a private window,
   "Rawiri". Set both to the same zoom so the text is readable at 1080p.
4. **Pick the testimony change in private.** Read `case/clue-graph.md` off camera. Choose a
   transition for a suspect **who is not the killer**, so the video shows the mechanic without
   the answer. Find that card before the take, or know which room gives it.
5. **Hints on cue.** The game master ticks every 90 seconds and gives a hint only when the group
   stalls. To show one on cue, use "Give the next hint" on the Host tab. It is the same authored
   hint, in the same order.
6. **Reveal.** Plan to blur or crop the killer's name and the solution text on the reveal
   screen. Show the layout and the labelled Claude commentary.

### Shot list

| Time | Beat | On screen | Voice-over (draft) |
|---|---|---|---|
| 0:00–0:12 | Hook | Lobby: rain, the title, the case brief | "A storm has cut off a lodge. The owner is dead at the foot of the cellar stairs. Four people are lying to you. Claude plays all of them." |
| 0:12–0:30 | Join with two browsers | A: type a name, Create room, copy the invite link. B: open the link, type a name. A: the waiting room lists both. A: Start the game. | "One player hosts and sends a link. Up to six can join. No accounts." |
| 0:30–0:55 | Private interviews | A interviews one suspect, B a different one, at the same time. Each asks a plain question. Point at "Private: only you see this conversation." | "Every interview is private. Claude answers in character, but only from what that suspect knows." |
| 0:55–1:30 | Evidence changes testimony | A: The Lodge, inspect a room, get a card. Pin it to the board; it appears on B's board with no refresh. A: present the chosen card to the chosen suspect. The suspect gives a new account. Present it again: an in-character "already told you", no change. | "Cards are private until you pin them. Show the right card to the right suspect and their story changes. The rules engine decides that, not the model, so it happens exactly once." |
| 1:30–1:45 | Game master hint | A: Host tab, "Give the next hint". Both browsers show the hint on The Lodge. | "An AI game master watches the room. When the group stalls, it picks a hint from an authored list. It cannot invent facts." |
| 1:45–2:20 | Accusation and reveal | A: Advance to Act 3. B: Accuse, pick a suspect, cite cards, submit. A: End the investigation. The reveal and the commentary appear on both screens. **Blur the culprit's name and the solution.** | "The group makes one accusation and backs it with evidence. Then the reveal, and Claude's commentary on how you played." |
| 2:20–2:40 | Architecture | "Behind the scenes" panel: Browser ⇄ Fly app · SSE → Postgres (MPG) ← Sprite agent → Claude via connector, and the "live model" count. Then the README architecture diagram. | "The game is a Fly App with Managed Postgres. The agent runs on a Fly Sprite. The app sends it an empty wake request; it claims jobs, calls Claude through the Sprites Anthropic connector, and goes back to sleep. A warm reply takes about 3 seconds. The Sprite holds no key and no game state." |
| 2:40–2:45 | Close | Lobby with the play link on screen | "Last Orders. Play it at last-orders.fly.dev." |

Keep every replied line as Claude wrote it. Do not cut away from a slow reply and splice in a
faster one; say on screen if a reply was sped up.

## (e) Pre-submission checklist

- [ ] https://last-orders.fly.dev/healthz returns `{"ok":true,"db":"up"}`.
- [ ] `curl -m 300 https://last-orders-gm-bu5ng.sprites.app/healthz` returns 200.
- [ ] Play one short game on the live site with two browsers. Replies show as live model, not
      simulated.
- [ ] https://github.com/BevanR/last-orders is public, and the README renders on GitHub: the
      mermaid diagram, the three screenshots, and the links.
- [ ] CI is green on `main`, and the latest deploy succeeded.
- [ ] Nothing public names the killer, the solution or the decisive evidence: the README, this
      file, the video, its thumbnail and title, and the social posts. (`case/` holds the
      solution by design; the README warns players.)
- [ ] The video is 2 to 3 minutes, uploaded, and viewable without signing in.
- [ ] The video link is added to the README under "Play it" and to the table at the top of
      this file.
- [ ] The short description is 150 words or fewer (149 now).
- [ ] Each social post is 280 characters or fewer, as the platform counts them, and tags
      @flydotio. Raw lengths with full URLs: post 1 is 260, post 2 is 279. X counts each link
      as 23 characters, which makes both shorter.
- [ ] Post one social post, then copy its link.
- [ ] Submit before midnight PST, Sunday 29 November 2026: code link, video link, short
      description, social post link.
- [ ] After the deadline, keep the app and the Sprite running so judges can play.
