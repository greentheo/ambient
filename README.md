# Ambient

**Live at [greentheo.github.io/ambient](https://greentheo.github.io/ambient/)**

A granular instrument for the browser. No timeline, no MIDI, no DAW — it is
always running, and you sculpt it with the keyboard and mouse. When something
good happens, you record it.

Built for the kind of thing loscil, Astropilot and Spaceship do: long sounds
smeared into clouds, drifting loops that never line up, everything soaked in
a big shared reverb.

## Running it

Any static server works — ES modules and `AudioWorklet` both need real HTTP,
so opening `index.html` from the filesystem will not work.

It also runs from the hosted copy above with nothing installed. To work on it
locally:

```bash
python3 tools/serve.py 8791
```

This is `http.server` with caching turned off — the plain version lets the
browser hold on to stale ES modules, which makes editing one look like it had
no effect. Then open <http://localhost:8791> and press **Begin**. Browsers will not start
audio without a click first.

## First time

Press **Begin** and a short tour walks you round the instrument, pointing at
the real thing at each step rather than describing it. It runs once; **?** in
the top bar has the full key reference and a button to run it again.

You never have to touch the keyboard. Every pad has a **▶** that fades it in
and out, every dial is drag-to-change, and every panel control is a normal
slider or button. The keys below are shortcuts, not the only way in.

### Deploying

GitHub Pages serves static files with a ten minute cache, so a browser that
has already loaded the app will keep the old stylesheet for a while after a
push. The stylesheet link carries a version query for that reason — **bump it
whenever `css/style.css` changes**, or a layout fix will appear to have done
nothing.

### On a phone or tablet

It works. Web Audio, the recorder and microphone capture all run on mobile,
and the hosted copy is served over HTTPS, which is what the mic needs. The
layout collapses to a single column and controls get larger tap targets.

Touch needs different gestures from a mouse, because the instrument fills the
screen and a drag has to be able to scroll it:

| | |
|---|---|
| **Tap** a pad | start or stop it |
| **Press and hold**, then slide | sculpt — move through the sound and open or close the filter |
| **Swipe** | scrolls the page, as anywhere else |

On a phone the panel order changes too: the pad's own controls sit directly
under the clips, with scenes and the shared effects below them, and **the
orbits are switched off** — a canvas repainting every frame is battery spent
on something you would have to scroll to see. Drawing is also skipped for any
waveform currently off screen, which on a page several screens long is most
of them.

A pad only takes the gesture away from the page once it has actually been
held; until then a drag belongs to the page. The pad outlines itself and the
phone gives a short buzz when it has hold of the sound. On a dial, only the
ring itself takes a drag — the rest of the cell scrolls — so the ring is drawn
larger on touch screens.

Web MIDI is not available on iOS, so a controller is desktop only. Eight dense
voices will also work a phone harder than a laptop — two or three is a better
starting point there.

## Playing it

| | |
|---|---|
| <kbd>1</kbd>–<kbd>8</kbd> | Fade a pad in / out (**Fade in** / **Fade out** per pad) |
| <kbd>Space</kbd> | Start / stop recording |
| <kbd>Esc</kbd> | Stop all — again within 2s cuts the tails too |
| Drag a tile | X = position in the source, Y = tone |
| <kbd>Shift</kbd> + drag | X = pitch, Y = grain size |
| Wheel over a tile | Grain density |
| <kbd>Shift</kbd> + wheel | Reverb send |
| Drop a file on a tile | Load it onto that pad |
| Drag a number | Adjust it (vertical); hold <kbd>Shift</kbd> for fine control |
| MIDI pad | Selects its track; hit it again to switch it on or off |

## Where sound comes from

Five ways, all landing in the same place — an `AudioBuffer` on a pad:

- **Drop a file.** Anything the browser can decode: WAV, MP3, FLAC, m4a.
- **Forge.** Generates raw material in-app — a partial stack (*Drone*),
  a slowly sweeping noise bed (*Air*), or struck inharmonic bells (*Bells*),
  at a chosen root and complexity. No assets, so the instrument makes sound
  the moment you open it.
- **Capture.** Records your microphone or an instrument straight onto a pad.
  Echo cancellation, noise suppression and auto-gain are all disabled — they
  are built to destroy exactly the sustained tones this wants. Monitoring is
  off by default; turn it on only with headphones.
- **Live.** Points a pad at a rolling window of the last few seconds of input
  and keeps it current, so you are granulating yourself as you play. **Freeze**
  locks the window — the sound stops but the cloud does not — and *Keep window*
  drops it onto the pad as an ordinary sample.
- **Freesound.** Text search against freesound.org, with results loading onto
  the selected pad. Needs a free API key, kept in `localStorage` and only ever
  sent to freesound.org. It loads preview renders rather than originals; full
  downloads are behind OAuth, and for material about to be shattered into
  grains the preview is not the weak link. **Credit the source when you
  release** — the status line shows the uploader and the sound's page.

## How it makes sound

Each pad is a granular voice. A scheduler fires overlapping short grains from
its buffer, each one windowed with a Hann envelope, randomly panned, randomly
pitched within a detune range, and played backwards a set fraction of the time.

The read head sweeps the whole source once every **Cycle** seconds, regardless
of how long the sample is. **There is no shared clock.** The pads default to
7.3 / 11.1 / 4.7 / 13.9 / 9.5 / 17.3 / 6.1 / 23.7 seconds — nothing divides
evenly into anything else, so they phase against each other for hours without
ever realigning. The **Cycles** strip shows this happening.

Everything then lands on a shared bus:

```
voices ─┬─ dry ────────────────────────────┐
        ├─ reverb send → convolver ────────┼→ saturate → master → limiter → out
        └─ delay send  → tape delay ───────┘
```

The reverb impulse response is synthesised at load time from filtered,
decaying noise — changing size, decay or darkness rebuilds it. The delay has a
lowpass in its feedback path and a slow LFO on its delay time, so repeats
darken and smear like tape.

## The clock

There is no timeline and no grid, but there is a clock, for when the music
should not be ambient. **Clock** starts it, **BPM** and **/bar** set the tempo
and bar length, **Click** turns on the metronome. The beat lamps show where
you are, with the downbeat accented.

Sync is **opt-in per pad**. A pad's **Sync** is `free` by default and carries
on drifting on its own Cycle; set it to a number of bars and its read head is
taken straight from the clock instead, so it can never drift out of agreement.
Pads 1-3 can stay at 7.3 / 11.1 / 4.7 seconds while pads 4-6 lock to 2 / 4 / 8
bars — ambient underneath, rhythm on top, in the same eight slots.

A locked pad shows its bar count instead of seconds, and its Cycle cell turns
green and reads what the tempo actually works out to. Changing tempo keeps the
current bar position, so nothing lurches mid-phrase. Sync travels with scenes.

The metronome is routed past the reverb and delay, so it is audible to you
without being part of what you are performing.

## Fades

**Fade in** and **Fade out** are per pad, up to 12 and 20 seconds. Grains keep
being scheduled for the whole of a fade-out — without that the cloud stops
within one grain and the gain ramp fades silence, which is what made switching
a pad off sound abrupt.

## Tone

The filter is two poles in series — 24dB/oct. A single pole barely bit on
material this broad. **Tone** sets the corner, and **Sweep** and **Rate** put
it in motion: a free-running LFO drives the filter's `detune` rather than its
`frequency`, so the sweep is exponential and travels the same musical distance
up as down. Sweep is in cents, so 1200 is an octave either side.

**Filter** switches between lowpass, bandpass and highpass. Bandpass is the one
that makes a sweep obvious: it takes the fundamental out as it travels, where a
lowpass sitting above everything has nothing to remove. On the stock drone,
sweeping a lowpass moves the dominant frequency from 120Hz to 780Hz; the same
sweep through a bandpass moves it from 190Hz to 4700Hz.

Each voice's LFO runs on its own clock, which means the filters drift against
each other the same way the read heads do.

A filter can only remove what is there. **Character** in the Forge sets how far
the drone's harmonic series extends — around 0.7 it is roughly a sawtooth,
which is the classic subtractive source precisely because it gives the filter
something to work on at every setting. Turn Character down and Tone will stop
doing much, because there is nothing left up top to take away.

Note that **Pos** moves on its own — the read head is always travelling at
whatever Cycle is set to. It repaints every frame so you can see it running;
it is not being nudged by whatever else you are touching.

## Stretch

The **Stretch** panel is a PaulStretch-style spectral transform, applied to a
pad's buffer in place. It cuts the source into long overlapping windows, keeps
each window's magnitude spectrum, throws its phase away, and overlap-adds the
result at a much slower rate. Losing the phase is the whole point: it dissolves
every transient and leaves only harmonic colour, smeared out as far as you
like. The two output channels get independent random phases, which is what
gives a stretch its wide diffuse image.

Cost scales with the factor — roughly 3 seconds of computing per ×8 of a
ten-second source, chunked so the interface stays responsive. Then set a long
Cycle and big grains over the result.

## Scenes

Scenes are how this gets structure without a timeline, so they live on the
main page under Cycles rather than behind a tab. **Store** the whole parameter
state into a slot, then **Morph** to it over anything up to three minutes.

The slot you last landed on is highlighted, the one you are gliding towards
fills with a progress bar, and a dot appears once you have played the state
away from the scene it came from — so mid-set you can always see where you
are and whether you are still on it. Nothing is sequenced — you are still playing it — but the piece moves.
Pads that are off in the target fade out and stop; pads that are on fade in
from silence.

Morphs run off the audio clock and a timer rather than the animation frame, so
switching windows mid-set cannot strand a glide halfway.

Scenes hold parameters, never audio.

**Save session** writes the slots, the current state, and — importantly — the
**audio itself** for anything that cannot be recreated. A forged source is
fully described by its parameters and rebuilds exactly, so it costs nothing.
A capture, a kept live window or a stretched buffer exists nowhere else, so it
is encoded to 16-bit WAV and embedded in the file. Roughly 1.4 MB per stereo
minute; the checkbox shows what a save will carry and can turn it off.

Sessions saved before this change contain source *labels* but no audio. They
still open, forged sources still rebuild, and anything that cannot be restored
is now named explicitly rather than dropped in silence.

## MIDI

Built around the common little controller — eight pads, eight knobs, two
octaves:

- **Pads** select a track. Hitting the pad you are *already* on is what
  switches it on or off — so grabbing a voice to get your hands on its knobs
  can never kill it by accident. (The number keys `1`–`8` still toggle
  immediately; they are a shortcut, not a performance surface.)
- **Knobs** drive Level, Cycle, Grain, Density, Rate, Tone, Spray and Sweep on
  whichever pad is selected. How a knob behaves is set by
  **Knobs** in the MIDI panel, and the choice is remembered:

  - **Pick up** (default) — the knob stays inert until you turn it *past* the
    value it is taking over, so changing pads mid-set does not make everything
    jump. While it waits, a red marker on the parameter cell shows where the
    knob currently sits, so an uncaught knob reads as *not caught yet* rather
    than as a dead control.
  - **Jump** — responds to the very first movement. Best when you are
    exploring and want to hear a change immediately.
  - **Relative** — every knob nudges from wherever the value already is.
    Nudges are proportional, so a log parameter like Tone or Cycle moves by
    musical distance rather than raw Hz, and the moves are symmetric.

  **Pitch** is always relative regardless of the mode, because a centred
  parameter with the knob parked at an extreme makes pick-up pure friction.
  See `RELATIVE` in `js/audio/midi.js` to add others.
- **Scene keys** — four more learned notes, each morphing to scene A–D over
  the Scenes morph time.
- **Launch keys** — eight notes that start pads. Play several as a chord and
  they come in as one gesture; play the same chord again and they all go out.
  The decision is made once for the whole group, so a chord can never leave
  half the pads lit.
- **Effect pads** — four notes that apply a gesture while held and put the
  voice back exactly as it was on release. **Freeze** locks the read head so
  the cycle stops and grains keep firing from one spot; **Shatter** goes to
  tiny grains at high density; **Reverb throw** sends hard so the wash trails
  after you let go; **Reverse** flips the read head. Also Pitch dive, Pitch
  lift, Muffle and Swarm. Each picks its effect and whether it acts on the
  selected pad or every live pad.
- **Swell keys** — four notes that lean on a parameter while held and let it
  sink back on release. Each one picks its target (Level, Density, Tone,
  Grain, Spray, Sweep, sends, Cycle…), how far to push it, and whether it acts
  on the selected pad or every live pad at once. The base value is captured
  when the key goes down, so a swell always returns to where you actually
  were rather than to a remembered default.
- **Keys** outside the learned pads and scene keys play notes into the cloud.
  Grains distribute themselves across whatever is held, so a sustained chord
  comes out as one cloud rather than as stacked voices. `a w s e d f t g y h u j k`
  does the same from the computer keyboard.

### Banks — a row of controls across all eight tracks

The mapping above is "this control drives whichever pad is selected". A
**bank** is the other shape: eight controls mapped to the eight *tracks* for
one parameter. A row of knobs becomes Tone on every track at once; a row of
faders becomes Level; a row of pads becomes start/stop. Nothing has to be
selected first.

Hit *Learn a bank of 8* and move eight controls in track order. Then pick what
the row drives. Bank controls own their track outright, so they respond
immediately — there is no value to catch, and soft takeover does not apply.
Turning one brings that track up on screen so what you are turning is what you
are looking at; that can be switched off per bank.

Banks record which device they came from, so two controllers using the same CC
numbers do not collide. Everything else stays device-agnostic, so an existing
mapping keeps working.

On a Launch Control XL that gives you three knob rows on three parameters
across all eight tracks, faders on level, and a pad row for start/stop —
leaving the MPK's pads and keys free for launch chords, scenes and swells.

Hit any *Learn* button and touch each control in the order you want it. A
control that already has another job is **taken over** rather than refused —
the status line says what it was taken from. Refusing silently just looks like
the controller has stopped working.

Note that **pads** and **launch keys** are different jobs. A pad selects its
track, and only switches it when you hit the one already selected. Playing
three pads together therefore selects three times; it is *launch keys* that
treat a chord as one gesture and bring several tracks in at once. A completed set saves itself; **Save
mapping** keeps a partial one, and **Clear mapping** starts over. Mappings live
in `localStorage`, so it is a one-time job per controller.

**Save preset…** and **Load preset…** write the mapping to a JSON file, for
moving a controller between machines or keeping one file per controller.

The connection does not persist the way the mapping does: browsers only hand
out MIDI access after you allow it, so **Connect MIDI** has to be pressed once
per browser. After that the permission is remembered and the app rebinds
silently on every load. Controllers plugged in after the page has loaded are
picked up too.

### If the controller is not doing anything

The **Incoming** line under the connect button shows the last message the page
received, with a running count. It is the one thing worth looking at first,
because it separates the two failure modes:

- **Nothing appears when you move a knob.** No messages are reaching the
  browser at all, so nothing about the mapping is relevant. The usual causes
  are the controller being held exclusively by another program (a DAW that is
  still open), or the browser having MIDI access but seeing no input ports —
  the panel says so explicitly and offers *Retry connect*.
- **Messages appear but nothing responds.** Now it is a mapping problem. The
  panel lists all three maps — pads, knobs and scene keys — so an `unmapped`
  row tells you exactly what still needs learning.
- **A pad tap shows "1 held" on the clip instead of switching it.** That pad's
  note is not in the pad map, so it is falling through to the chord handler
  and being played as a note. Press *Learn 8 pads*. The panel warns about this
  case directly.
- **A knob does nothing until you turn it a long way.** That is *Pick up*
  waiting to catch the current value — watch for the red marker showing where
  the knob is. Switch **Knobs** to *Jump* or *Relative* if you would rather
  not wait.

The status line reports how many input ports were actually bound. It will not
claim a connection when none were found.

Learning stages into a scratch list and only replaces your saved mapping once
a full set has been captured, so a learn that receives nothing leaves what you
had intact. Press an armed learn button again to back out. A note already used
as a pad cannot also be learned as a scene key, or the other way round.

The eight parameter cells on the **Pad** tab are laid out in knob order and
badged `K1`–`K8`, so what is under your left hand matches what is on the
screen — Level, Cycle, Grain, Dens, Rate, Detune, Verb, Sweep. The rest
(Pos, Tone, Spray, Pitch, Rev, Width, Delay) follow. **Cols** sets how many columns they wrap
into — put it on 4 to mirror two rows of four knobs, or 8 for a single row.
Each cell doubles as its own level meter: the light grey fill is the value,
with the label and number in black on top of it.

## When it gets out of control

**Stop all** (or <kbd>Esc</kbd>) fades every voice out and drops any held
notes. Press it again within two seconds and it also mutes the master and
flushes the delay line — on high feedback the tail can ring for the best part
of a minute, so stopping the voices alone is not enough. The bus restores
itself about a second later, so you can go straight back to playing.

## Recording

An `AudioWorklet` taps the master output and encodes a 16-bit stereo WAV on
stop, which downloads as `ambient-YYYYMMDD-HHMM.wav`.

Audio is held in memory until you stop, at roughly **10 MB per minute**. Long
sessions are fine, but a 40-minute take will be using around 400 MB before it
encodes.

## Look

**Look** in the top bar switches palette — *Slate* (the original dark blue),
*Ember* (warm lamplight), *Neon* (loud, for a room with a projector), *Tide*
(deep water) and *Paper* (daylight, for working on it rather than performing
with it). Every colour, including the ones the canvases draw with, comes from
the palette, so nothing is left behind when you switch. The choice is
remembered.

**Cycles** is drawn as eight bodies orbiting a sun. The angle around an orbit
is the pad's cycle position, so that part is the real data — but the orbits
themselves drift. Bodies tug on each other's radius and eccentricity as they
pass, and each one springs slowly back towards its home orbit, so the paths
are never quite the same twice and the picture wanders without ever flying
apart or collapsing.

It is perturbed Keplerian rather than a true n-body simulation, deliberately:
a real n-body would either escape or collide, and the angles have to stay tied
to the cycles for the picture to mean anything. The chaos is in the shape of
the orbits, not in where the bodies are on them.

Orbits scatter across the whole system at startup rather than ranking
themselves by track number, and each one breathes: its size swells and
contracts on its own slow clock so orbits pass through one another, and its
shape drifts across the full range from a near circle to a long comet ellipse
on a slower clock still. The radius is normalised by eccentricity so the far
side stays in frame however elongated it gets, with the sun at a focus — the
ellipse is genuinely off-centre rather than merely squashed.

The layout below the pads is three columns: **Scenes** stacked down the left
with **Stretch**, **Reverb** and **Tape delay** beneath them, the tabbed
working panels in the middle, and the orbits on the right. The orbit pane
is square and sits at the top of its column rather than stretching — a tall
tab like MIDI would otherwise drag the system down past the fold. The
scattering, breathing and drifting eccentricity are there so it uses all of
the square it has, rather than so it can grow.

**Parameters are dials**, with the label and value beside the ring rather than
inside it, so the dial can use the full height of its cell. Everything scales
with the viewport — pad titles, dial rings and numbers all grow on a big
screen instead of leaving it in small type.

## Screen

The layout is fluid rather than fixed: pads, panels and scene slots reflow to
fill the width, and past about 2200px all eight pads sit on one row so the
whole set reads at a glance. **Size** in the top bar scales the whole interface
from XS to XXL — useful on a large monitor being read from across the room,
which is the position you are in while actually performing.

## The world

`viz.html` is a separate page — **World** in the top bar opens it in its own
window. Put it on a second screen and press `F` for fullscreen. It runs in its
own tab deliberately: heavy drawing there never competes with the grain
scheduler here, which is the thing that must not stutter.

State crosses between them over a `BroadcastChannel` — same origin, no server.
It is posted on a timer off the audio clock, never `requestAnimationFrame`,
because the instant the world goes fullscreen on another screen this tab is
backgrounded and rAF stops.

The world is generated from a seed in the URL, so a place you like can be
found again. `N` rolls a new seed, `W` cycles worlds, `H` hides the readout.

### Arcs — the shape of a world's time

Not every place is a full day. A scene declares an **arc**: a few keyframes of
sun elevation across normalised time, which the host runs the clock along.

| arc | |
|---|---|
| `transit` | a whole day and night, looping |
| `sunset` | one long descent across the set, then it holds |
| `sunrise` | the reverse |
| `night` | never gets light; the moon does the work |
| `day` | never gets dark; flat overcast |

`?arc=<name>` overrides whatever the scene proposes, and `?day=<seconds>`
scales the whole arc — the same shape can be a four minute piece or a forty
minute one. `A` cycles arcs in place, so you can see one valley at every hour
without touching the code. New arcs are a few lines in `js/viz/arc.js`.

### The world clock

The world reports its clock back to the instrument on a second channel, and
the top bar shows it: **`evening · sunset in 33s · 8 citizens`**, going amber
under 75 seconds and red under 20.

This is the point of the link. The world is seeded and its arc is known, so
you can see the sunset coming and bring the next scene in to meet it — the
piece gets written to the light rather than reacting to it. The world reports
and never steers; nothing here touches a parameter you might have a hand on.

Like the state feed, it is posted on a timer rather than from the render loop,
so the clock keeps arriving even when the world is behind the instrument.

### Editing a world

Press `E` in the visualiser, or the quiet **edit** button top right. The panel
is generated from a schema the scene publishes, grouped into Landscape, City,
Foreground and Life. Changes apply live — structural ones (ridge count, block
count, tower shape) rebuild the world in place, the rest are read every frame
anyway.

Values are remembered per world in `localStorage`. **Save file** writes a
config carrying the world, arc, seed and every parameter, so a look you like
travels as one file; **Load file** restores all of it. **Reset** returns to the
scene's defaults.

Seed and arc length are editable in the panel too — changing either reloads,
since the whole place is generated from them.

A scene gets its editor for free by declaring parameters:

```js
const params = [
  { k: 'ridges', label: 'Ridges', min: 2, max: 6, step: 1, def: 4,
    group: 'Landscape', rebuild: true },
];
```

`rebuild: true` marks a value that is baked when the world is generated, and
so needs `scene.rebuild(seed, cfg)` rather than just the next frame.

### A world per set

Worlds are modules under `js/viz/scenes/`. A scene owns everything about how
a place looks and behaves; the host only supplies the clock and the state of
the music, and what any of it means is up to the scene. Adding a world for a
new set means adding a file and listing it in `SCENES` — nothing else changes.

The interface is small on purpose:

```js
export default {
  id: 'valley',
  name: 'Valley',
  create: (seed) => new Valley(seed),
};

class Valley {
  update(dt, s, env) {}                 // s = music, env = { seconds, sunHeight, night, warmth, angle }
  draw(ctx, w, h, s, env) {}
  status() { return '8 citizens'; }     // shown in the corner
}
```

`?world=<id>&seed=<n>&day=<seconds>` selects one. Seeds are shared across
worlds, so the same number can be handed to a different scene to see the same
place imagined differently.

What the music does to it:

| | |
|---|---|
| Each pad's cycle phase | one beacon on the tower, pulsing on its own clock |
| Active pads | how many citizens are out |
| Master level | ambient light, window brightness, walking pace |
| Filter brightness | colour temperature of the whole sky |
| Grain density | snowfall |
| Reverb size | depth of haze between the ridges |
| Scene morph | pushes the sun along, so a scene change is a time of day |

The beacons are the point. The polyrhythm is the composition, and putting one
beacon per pad on the side of the building makes it something you can watch
drift apart rather than an abstraction — eight lights that will not coincide
again for hours.

The citizens are not on loops. Each picks somewhere to go, changes its mind,
notices whoever is nearby, stops to talk, works for a while, and wanders off
when the music thins out. Nothing repeats on a fixed period, which is what
makes it hold up over the length of a set rather than a minute.

With no instrument running it falls back to a demo, so the world can be worked
on by itself. `window.__viz` exposes `{ link, world, people, weather }`.

## Layout

```
index.html
css/style.css
js/app.js                    UI, input, drawing, wiring
js/audio/engine.js           master bus, grain scheduler
js/audio/granular.js         the granular voice — the instrument itself
js/audio/sources.js          procedural generators, file decoding
js/audio/ir.js               synthesised reverb impulse responses
js/audio/capture.js          microphone / instrument input
js/audio/livebuf.js          rolling live-input window
js/audio/stretch.js          FFT and spectral timestretch
js/audio/midi.js             Web MIDI, learn and soft takeover
js/audio/freesound.js        freesound.org search
js/audio/broadcast.js        publishes state to the world
js/snapshots.js              scene capture and morphing
viz.html                     the world, for a second screen
js/viz/viz.js                host: clock, music framing, scene registry
js/viz/scenes/valley.js      the first world
js/viz/arc.js                shapes of a world's time
js/viz/config.js             live parameter editing, save and load
js/viz/world.js              seeded terrain, tower, city
js/viz/sky.js                sun, stars, weather
js/viz/agents.js             the citizens
js/viz/link.js               receives state, eases it, demo fallback
js/viz/rng.js                seeded noise
js/audio/recorder.js         WAV encoding
js/audio/recorder-worklet.js PCM tap
```

`window.__ambient` exposes `{ engine, pads, recorder, input }` from the console
while you are working on it.
