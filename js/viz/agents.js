// The citizens.
//
// Each one is a small state machine with somewhere to be and an opinion about
// whether to stop on the way. They are not on loops — they pick destinations,
// notice each other, stand around talking, and drift home when the music
// thins out. The point is that nothing in here repeats on a fixed period, so
// watching it for twenty minutes keeps turning up things you have not seen.

const WALK = 'walk', IDLE = 'idle', TALK = 'talk', WORK = 'work', LEAVE = 'leave';

let nextId = 1;

class Agent {
  constructor(rand, world) {
    this.id = nextId++;
    this.rand = rand;
    this.world = world;
    this.u = rand();                       // position across the plaza, 0..1
    this.target = rand();
    this.speed = 0.010 + rand() * 0.022;
    this.state = WALK;
    this.timer = 1 + rand() * 4;
    this.partner = null;
    this.lamp = rand() > 0.45;             // some carry a light
    this.hue = rand();
    this.bob = rand() * Math.PI * 2;
    // Depth across the plaza. They move through it as well as across it, so
    // the crowd has somewhere to be rather than standing on one line.
    this.depth = rand();
    this.depthTarget = rand();
    this.depthSpeed = 0.02 + rand() * 0.05;
    this.armPhase = rand() * Math.PI * 2;
    this.shook = false;
    this.alpha = 0;                        // fades in on arrival
    this.leaving = false;
  }

  pick() {
    // Somewhere else, but far enough away to be worth the walk.
    let t;
    do { t = this.rand(); } while (Math.abs(t - this.u) < 0.08);
    this.target = t;
    this.depthTarget = this.rand();
  }

  get scale() { return 0.62 + this.depth * 0.72; }

  step(dt, mood, agents) {
    this.alpha = Math.min(1, this.alpha + dt * 0.6);
    this.bob += dt * (this.state === WALK ? 7 : 2);
    this.armPhase += dt * (this.state === TALK ? 4.5 : 1.2);
    this.timer -= dt;

    // Drift through the depth field while walking, so figures pass in front
    // of and behind each other instead of sharing one line.
    if (this.state === WALK) {
      const dd = this.depthTarget - this.depth;
      this.depth += Math.sign(dd) * Math.min(Math.abs(dd), this.depthSpeed * dt * (0.5 + mood));
    }

    switch (this.state) {
      case WALK: {
        const d = this.target - this.u;
        const dir = Math.sign(d);
        // Mood comes from the music: a brighter, busier mix walks faster.
        this.u += dir * this.speed * dt * (0.5 + mood * 1.3);
        this.facing = dir;
        if (Math.abs(d) < 0.006) {
          this.state = this.rand() < 0.34 ? WORK : IDLE;
          this.timer = 2 + this.rand() * 7;
        } else if (this.timer <= 0) {
          // Someone nearby is more interesting than where they were going.
          const near = agents.find((a) => a !== this && !a.leaving
            && Math.abs(a.u - this.u) < 0.035 && a.state !== TALK);
          if (near && this.rand() < 0.55) {
            this.state = TALK; this.partner = near; this.timer = 3 + this.rand() * 8;
            near.state = TALK; near.partner = this; near.timer = this.timer;
          } else {
            this.timer = 2 + this.rand() * 4;
          }
        }
        break;
      }
      case IDLE:
      case WORK:
        if (this.timer <= 0) { this.pick(); this.state = WALK; this.timer = 2 + this.rand() * 4; }
        break;
      case TALK: {
        // Face each other and close the gap a little.
        if (this.partner) {
          this.facing = Math.sign(this.partner.u - this.u) || 1;
          const dd = this.partner.depth - this.depth;
          this.depth += Math.sign(dd) * Math.min(Math.abs(dd), 0.06 * dt);
        }
        // A lamp changes hands once per meeting, if only one of them has one.
        if (!this.shook && this.partner && this.timer < 2.2) {
          this.shook = true;
          this.partner.shook = true;
          if (this.lamp !== this.partner.lamp && this.rand() < 0.45) {
            const from = this.lamp ? this : this.partner;
            const to = this.lamp ? this.partner : this;
            from.lamp = false;
            to.lamp = true;
          }
        }
        if (this.timer <= 0 || !this.partner || this.partner.state !== TALK) {
          this.partner = null;
          this.shook = false;
          this.pick();
          this.state = WALK;
          this.timer = 2 + this.rand() * 4;
        }
        break;
      }
      case LEAVE:
        this.u += (this.u < 0.5 ? -1 : 1) * this.speed * dt * 1.6;
        this.alpha -= dt * 0.35;
        break;
    }

    if (this.u < -0.05 || this.u > 1.05) this.dead = true;
    if (this.alpha <= 0 && this.leaving) this.dead = true;
  }

  send() { this.leaving = true; this.state = LEAVE; }
}

export class Population {
  constructor(rand, world) {
    this.rand = rand;
    this.world = world;
    this.agents = [];
  }

  /** @param {number} want how many citizens the music is asking for */
  update(dt, want, mood) {
    const living = this.agents.filter((a) => !a.leaving).length;
    if (living < want && this.rand() < dt * 1.6) {
      this.agents.push(new Agent(this.rand, this.world));
    } else if (living > want && this.rand() < dt * 1.2) {
      const victim = this.agents.find((a) => !a.leaving);
      if (victim) victim.send();
    }
    for (const a of this.agents) a.step(dt, mood, this.agents);
    this.agents = this.agents.filter((a) => !a.dead);
  }

  draw(ctx, w, h, groundY, warmth, night) {
    // Furthest first, so nearer citizens genuinely pass in front.
    const order = [...this.agents].sort((p, q) => p.depth - q.depth);
    for (const a of order) {
      const x = a.u * w;
      const y = (groundY(a.u) + a.depth * 0.085) * h;
      // Big enough to read as people, since the plaza is the foreground.
      const s = h * 0.055 * a.scale;
      const bob = a.state === WALK ? Math.abs(Math.sin(a.bob)) * s * 0.08 : 0;

      ctx.globalAlpha = Math.max(0, a.alpha) * 0.92;

      // Lamp first, so the body reads as a silhouette against its own light.
      if (a.lamp && night > 0.15) {
        const hand = a.hand;
        const lx = hand ? hand.ax : x + s * 0.42 * (a.facing || 1);
        const ly = hand ? hand.ay + s * 0.05 : y - s * 0.55;
        const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, s * 4.5);
        g.addColorStop(0, `rgba(255,${196 + warmth * 40},${130 + warmth * 40},${0.30 * night})`);
        g.addColorStop(1, 'rgba(255,190,130,0)');
        ctx.fillStyle = g;
        ctx.fillRect(lx - s * 5, ly - s * 5, s * 10, s * 10);
        ctx.fillStyle = `rgba(255,226,178,${0.85 * night})`;
        ctx.fillRect(lx - s * 0.07, ly, s * 0.14, s * 0.14);
      }

      ctx.fillStyle = '#05070c';
      const headR = s * 0.15;
      const headY = y - s + bob * -1;
      const shoulderY = headY + headR * 1.5;
      const hipY = y - s * 0.42;
      const lean = a.state === WORK ? s * 0.13 : 0;
      const face = a.facing || 1;

      ctx.beginPath();
      ctx.arc(x + lean * 0.7, headY, headR, 0, Math.PI * 2);
      ctx.fill();

      // Torso: shoulders wider than hips, so it reads as a body rather than
      // as another post along the plaza.
      ctx.beginPath();
      ctx.moveTo(x - s * 0.19 + lean, shoulderY);
      ctx.lineTo(x + s * 0.19 + lean, shoulderY);
      ctx.lineTo(x + s * 0.13, hipY);
      ctx.lineTo(x - s * 0.13, hipY);
      ctx.closePath();
      ctx.fill();

      // Legs, with a real gap between them when walking.
      const swing = a.state === WALK ? Math.sin(a.bob) * s * 0.13 : s * 0.045;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.10, hipY);
      ctx.lineTo(x - s * 0.02, hipY);
      ctx.lineTo(x - s * 0.03 - swing, y);
      ctx.lineTo(x - s * 0.11 - swing, y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + s * 0.02, hipY);
      ctx.lineTo(x + s * 0.10, hipY);
      ctx.lineTo(x + s * 0.11 + swing, y);
      ctx.lineTo(x + s * 0.03 + swing, y);
      ctx.closePath();
      ctx.fill();

      // Arms. They swing when walking, reach out to shake when two people
      // meet, and hang while idle.
      const armLen = s * 0.30;
      const drawArm = (side) => {
        let ax, ay;
        if (a.state === TALK && side === face) {
          // Reaching across — with a small shake once the greeting starts.
          const shake = a.shook ? Math.sin(a.armPhase * 3) * s * 0.03 : 0;
          ax = x + face * armLen * 0.95;
          ay = shoulderY + s * 0.16 + shake;
        } else if (a.state === WALK) {
          const sw = Math.sin(a.armPhase * 1.6 + (side > 0 ? Math.PI : 0)) * s * 0.13;
          ax = x + side * s * 0.13 + sw;
          ay = shoulderY + armLen * 0.85;
        } else if (a.state === WORK) {
          ax = x + side * s * 0.12 + lean;
          ay = shoulderY + armLen * 0.55;
        } else {
          ax = x + side * s * 0.16;
          ay = shoulderY + armLen * 0.9;
        }
        ctx.beginPath();
        ctx.moveTo(x + side * s * 0.15 + lean, shoulderY + s * 0.03);
        ctx.lineTo(ax, ay);
        ctx.lineWidth = Math.max(1, s * 0.075);
        ctx.strokeStyle = '#05070c';
        ctx.lineCap = 'round';
        ctx.stroke();
        return { ax, ay };
      };
      const armL = drawArm(-1);
      const armR = drawArm(1);
      a.hand = face > 0 ? armR : armL;

      // A cold rim off the sky, so nobody is a pure black cut-out.
      ctx.globalAlpha *= 0.5;
      ctx.fillStyle = `rgba(${150 + warmth * 60},${168},${196},0.8)`;
      ctx.fillRect(x - headR * 0.9 + lean * 0.7, headY - headR, headR * 1.8, 1.1);
      ctx.fillRect(x - s * 0.19 + lean, shoulderY, s * 0.38, 1.1);
      ctx.globalAlpha = 1;
    }
  }
}
