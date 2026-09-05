# Modes — what the page is for

A mode is the second word after the verb: `/design polish --mode operate`. It
does not change *what* a verb does; it changes the defaults the verb reaches
for, because the same fix is right on a landing page and wrong on a dashboard.
When no mode is given, infer one from the target (a route under `/docs` reads,
a table-heavy screen operates) and say which you inferred.

| Mode | The page must … | Defaults it sets |
| --- | --- | --- |
| `persuade` | move a reader to one action | one hero, one primary action, proof over adjectives, honest metrics or none, generous measure, motion only on entry |
| `operate` | let someone work fast for hours | dense but aligned grid, tabular numerals, keyboard paths, visible states (empty/loading/error/selected), no hero, restrained accent used only for status |
| `read` | be understood end to end | 60–75 ch measure, one type family plus one for code, a real heading hierarchy, persistent navigation, zero decoration that does not aid reading |
| `experience` | be felt as much as used | atmosphere and motion allowed, but every effect respects `prefers-reduced-motion`, contrast still passes, and the content stays reachable without the effect |

## Rules that hold in every mode

- Contrast, focus order, and target size are not mode-dependent. `experience`
  is not a licence to fail WCAG.
- A mode never adds sections. If `persuade` seems to need testimonials the
  brief did not supply, that is a missing input, not a design move.
- State the mode you used in the receipt so the next verb starts from it.
