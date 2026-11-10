# Settlers of Friends

An island-settling board game for 2 to 6 friends, played from your phones. Roll for resources,
build roads, settlements and cities, trade for what you're missing, and be the first to 10 points.

Every phone carries the whole island and your secret hand, so **a TV is optional**. Put the
island on a big screen as well and it becomes the table everyone looks up at.

Built the same way as Friend Feud, Friend Jeopardy, Friend Wheel, Friend Monopoly, Friend Clue,
Legendary Friends and Friend Bingo: one small Node server, one page for phones, one for the TV.

## Playing

1. One person opens the site on their phone, types a name and taps **Start a new game**.
   They get a 4-letter room code (and a QR code and a share link) and become the captain.
2. Everyone else opens the site, enters the code and their name, and picks a color and a face
   (an emoji, or a photo from their camera roll).
3. The captain picks the settings and taps **Start the game**. Bots can fill empty seats.
4. Optional: open `/tv` on a computer plugged into a TV and choose **Show a game from a phone**.
   You can also start the room from the TV page instead, like the other games.

There is a **?** on every phone with the rules and what everything costs.

### On your phone

- The island is on top. Pinch or tap **＋** to zoom, drag to move around.
- When it's time to place something, the legal spots glow. Tap one, then **Place it**
  (or tap the same spot again).
- Your cards are in a row under the island. The four buttons under them never move:
  **Build**, **Trade**, **Cards** (development cards) and **Roll / End turn**.
- When you can afford something, a shortcut for it appears right above your cards.

### Trading

- **Offer to the table.** Pick what you give and what you get and send it. It lands on every
  phone; each player taps Accept, Counter or Pass. You watch the answers come in and choose who
  to trade with.
- **Ask.** Leave "you give" empty to ask "who has brick?". Players answer with their price.
- **Counter.** A counter-offer stays in the same thread; the offerer can take it or turn it down.
- **Just one player.** Send an offer to one person and the rest of the table only sees that the
  two of you are talking. (A finished trade is always announced, as at a real table.)
- **Bank and ports.** Same screen, second tab. Your best rate is worked out for you: 4:1, 3:1
  with any port, 2:1 with that resource's port.
- Both sides see a hint when a trade would let them afford something new.
- You can't offer cards you don't hold, give cards away for nothing, or swap a resource for
  itself. An offer is withdrawn on its own if your hand changes and you can't cover it.

### Settings (captain's phone, or the TV that started the room)

| Setting | Choices |
| --- | --- |
| Points to win | Quick 8 · Standard 10 · Long 12 |
| The island | Starter (the same fair island every game) · Balanced (a new fair island) · Random |
| Trading | Official (every trade includes the player whose turn it is) · Open table (anyone, any time) |
| Turn clock | Off · 1 min · 90 s · 2 min · 3 min |
| Friendly robber | The robber leaves players with 2 points or fewer alone |
| Balanced dice | Each number comes up as often as it should over a game |
| Extra build phase | The official rule for 5 or 6 players: everyone may build between turns |

2 to 4 players get the classic island (19 hexes). 5 or 6 get the big island (30 hexes).

### Rules it follows

The standard rules: the opening goes round the table and back; a settlement must be two corners
from any other; roads connect to your own network; a 7 makes anyone holding more than 7 cards
discard half, then the roller moves the robber and steals a card; one development card a turn,
never the turn you bought it; Longest Road needs 5 and Largest Army needs 3 knights; if the bank
can't pay everyone a resource, nobody gets it; you can only win on your own turn.

### If something goes wrong

- **Phone died or closed the page:** open the site again. You're put straight back in your seat.
  From a different phone, join with the same name.
- **Someone has to leave:** "Leave the game" hands their seat to a bot so the island stays
  balanced. Joining again with the same name takes the seat back.
- **Someone's phone goes quiet on their turn:** after about 25 seconds the game rolls and ends
  the turn for them.
- **The server restarts mid-game:** every phone (and the TV, if it started the room) holds a
  sealed copy of the game and hands it back. The game carries on with the same code.
- **Out of time tonight:** the captain's menu has **Save the game for another night**. It is
  saved on that phone (or TV). Resume it from the start screen; everyone joins the new code with
  their old names.

## Running it

```
npm install
npm start        # http://localhost:3000  (TV page: /tv)
npm test         # plays scripted games and whole bot games, about a minute
```

On Render: a free Node web service from this repo, build `npm install`, start `node server.js`
(`render.yaml` has it). Every push to `main` deploys; open pages reload themselves onto the new
version.

## Files

| File | What it is |
| --- | --- |
| `server.js` | Rooms, turns, dice, the robber, trading, bots, backups. The only source of truth. |
| `rules.js` | The map and the rules the server and both pages share. |
| `common.js` | Shared by both pages: connection, dialogs, sounds, icons, drawing the island. |
| `index.html` | The phone page. |
| `tv.html` | The big-screen page. |
| `style.css` | The shared look and the fonts (Germania One and Rubik, both open source). |
| `test/play.js` | The tests. |

All the artwork is drawn in code for this game. Sounds are synthesized in the browser.
