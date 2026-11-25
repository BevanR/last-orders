# Last Orders: Clue Graph

Companion to `bible.md`. Solid arrows mean "yields" or "supports". Dotted arrows mean "unlocks" or "enables". Act I accounts are given on the first interview, so they need no trigger.

```mermaid
flowchart LR
  subgraph LOC["Locations and visible actions"]
    DIN["L1 Dining Room - Act I<br/>Inspect camera"]
    CELA["L2 Wine Cellar - Act I<br/>Inspect foot of stairs"]
    KIT["L3 Kitchen - Act I<br/>Inspect walk-in chiller"]
    CELB["L2 Wine Cellar - Act II<br/>Inspect storm hatch"]
    OFF["L4 Office - Act II<br/>Inspect desk / phone"]
    BOOT["L5 Boot Room - Act II<br/>Inspect shoe rack and coats"]
    WOOD["L6 Woodshed - Act II and (E2 or TT1)<br/>Search woodpile"]
  end

  subgraph EV["Evidence"]
    E1["E1 Wrong bottle"]
    E2["E2 Storm hatch prints"]
    E3["E3 Time-lapse frames"]
    E4["E4 Imported whitebait"]
    E5["E5 Office phone log"]
    E6["E6 Helen's note"]
    E7["E7 Sandy brogues"]
    E8["E8 Magnum in the scarf"]
  end

  subgraph TR["Testimony"]
    AACC["Aroha Act I account:<br/>nobody passed her door, one smash about 21:49"]
    TL1["TL1 Lionel: walked the sea side"]
    TL2["TL2 Lionel: scarf, walked the sea side"]
    TL34["TL3 / TL4 Lionel: entered by the hatch,<br/>claims she slipped"]
    TL5["TL5 Lionel: admits the 'loans'"]
    TD1["TD1 Dougal: phone call,<br/>torch on north path about 21:53"]
    TD2["TD2 Dougal: 12 years, never saw the books"]
    TT1["TT1 Tessa: took the watch,<br/>torch at woodshed about 21:51"]
    TT2["TT2 Tessa: heard 'Monday' at 18:20,<br/>saw Lionel leave the office"]
    TA1["TA1 Aroha: hatch bolted Thursday,<br/>Lionel in cellar at 18:40"]
    TA2["TA2 Aroha: whitebait is imported"]
    SCARF["Reactions to E8 from Dougal, Tessa, Aroha:<br/>that is Lionel's scarf"]
    BROGUE["Brogues are Lionel's: only he came back in slippers (E3),<br/>his own slipper lie, Tessa's reaction to E7"]
  end

  subgraph CON["Conclusions"]
    C1["C1 Murder, not a fall:<br/>staged scene, magnum was the weapon"]
    C2["C2 Killer came and went<br/>by the storm hatch"]
    C3["C3 Lionel Fitch is the killer"]
    C4["C4 Motive: the missing $412,600"]
    C5["C5 Dougal cleared:<br/>alternative theory fails"]
    C6["C6 Tessa cleared"]
    C7["C7 Aroha cleared"]
  end

  DIN --> E3
  CELA --> E1
  KIT --> E4
  CELB --> E2
  OFF --> E5
  OFF --> E6
  BOOT --> E7
  WOOD --> E8

  E2 -.->|unlocks| WOOD
  TT1 -.->|unlocks| WOOD

  E3 -->|present to Tessa| TT1
  E4 -->|present to Aroha| TA2
  E2 -->|present to Aroha| TA1
  E5 -->|present to Dougal| TD1
  E6 -->|present to Dougal| TD2
  E6 -->|present to Tessa| TT2
  E6 -->|present to Lionel| TL5
  E7 -->|present to Lionel| TL1
  E8 -->|present to Lionel| TL2
  TL1 -.->|enables| TL34
  TL2 -.->|enables| TL34
  E2 -->|present to Lionel| TL34
  E8 -->|present to Lionel after TL1| TL34
  E8 --> SCARF
  E7 --> BROGUE

  E1 --> C1
  E8 --> C1
  AACC --> C1

  E2 --> C2
  E3 --> C2
  TT1 --> C2
  TD1 --> C2
  TL34 --> C2
  TA1 --> C2

  E8 --> C3
  SCARF --> C3
  E3 --> C3
  E2 --> C3
  E7 --> C3
  BROGUE --> C3
  C2 --> C3
  TL34 --> C3

  E6 --> C4
  TT2 --> C4
  TD2 --> C4
  TL5 --> C4

  E5 --> C5
  TD1 --> C5
  TD2 --> C5
  TT2 --> C5

  E3 --> C6
  AACC --> C6
  TT1 --> C6

  E3 --> C7
  E7 --> C7

```

## Independent paths for each conclusion

Two paths count as independent when they share no evidence card and no testimony transition. Act I accounts are always available.

| Conclusion | Path 1 | Path 2 | Further path(s) |
|---|---|---|---|
| **C1** Murder; the fall was staged; the magnum was the weapon | **E1**: Helen went for the magnum, the magnum is gone, and a cooking bottle was smashed beside her. The injury is at the back of her head although she fell forward. | **E8**: the magnum, hidden in a woodpile, with a smear and grey hairs on its base. | Aroha's Act I account: one smash at about 21:49, nine minutes after Helen went down, with no thump. |
| **C2** The killer came and went by the storm hatch | **E2**: bolt drawn from inside; wet ironsand prints from the hatch to the stairs and back. | **TT1 + TD1**: two separate sightings, during the death window, of a torch at the woodshed beside the hatch (about 21:51) and then on the north path heading for the front (about 21:53). | **TA1**: the bolt was drawn at 18:40. **TL3/TL4**: Lionel admits it. Aroha's account and E3 rule out the dining-room end of the corridor only; the hall passage stays open until E2. |
| **C3** Lionel Fitch is the killer | **Weapon path: E8 + scarf identification.** The weapon was wrapped in Lionel's red tartan scarf. The scarf is identified by the reactions of Dougal, Tessa and Aroha to E8, or by E3 (on him at 21:42, gone at 21:57). | **Route path: E2 + E7 + brogue identification.** The hatch prints have a crescent nick in the left heel. The sandy brogues have the same nick; the car park is gravel. The brogues are identified as Lionel's by Tessa's reaction to E7 or by Lionel's own slipper lie ("I changed in the boot room"), or by E3 (only he came back in slippers). | **Admission: TL3/TL4.** **Motive: C4.** |
| **C4** Motive: the missing $412,600 | **E6 + TD2**: the note says the money went through the books over 15 years and the culprit has known Helen 40 years; Dougal says he has known her 12 years and Lionel keeps the books (Lionel says so himself in his Act I account). | **TT2**: Tessa heard "Monday. Not a day later." at 18:20 while Dougal was in the lounge, then saw Lionel leave the office. | **TL5**: Lionel admits the "loans". |
| **C5** Dougal is cleared (the alternative theory fails) | **E5 + E3**: the corded office phone was in use 21:46–21:55; only Dougal and Lionel were away for the whole call, and Lionel was outside (E7). TD1 confirms it was Dougal. | **TD2 + TT2**: the note's "forty years" does not fit him (twelve years), he never saw the books, and he was in the lounge when Helen said "Monday" to Lionel. | **E2 + E7**: the nicked heel is on Lionel's sandy brogues, not Dougal's dry shoes. Aroha's smash at about 21:49 falls inside his call. |
| **C6** Tessa is cleared | **Weak: E3 + Aroha's Act I account.** Tessa was at the table until 21:50, and the smash came at about 21:49. This rests on a one-minute gap and Aroha's estimate of the time. | **E3**: at 21:50 she starts up the main stairs and at 21:58 she comes back down them; the cellar is downstairs, and the stairs are the only way up. | **TT1**: she was upstairs in Helen's room, watching the torch at the woodshed. |
| **C7** Aroha is cleared | **E3**: she is at the kitchen bench from 21:41 to 21:59 and never out of shot for more than 20 seconds. | **E2 + E7**: the prints are a men's size 11 leather brogue with a nicked heel, and that brogue is Lionel's. | None needed. E4 / TA2 explain why she lied about the whitebait. |

The two decisive paths for C3 share no card when the identifications come from testimony: the weapon path uses E8 and the reactions to it; the route path uses E2, E7 and Tessa's reaction to E7 or Lionel's slipper lie. E3 can identify both the scarf and the shoes, but neither path needs it. Either path alone names Lionel and places him at the scene with the method.
