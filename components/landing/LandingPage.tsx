"use client";

import { useRef } from "react";
import Image from "next/image";
import {
  gsap,
  useGSAP,
} from "@/lib/gsap";

const rates = [
  ["NGN / USDC", "₦1,531.20", "+0.18%"],
  ["EUR / USDC", "€0.9231", "−0.04%"],
  ["KES / USDC", "KSh 129.84", "+0.09%"],
  ["BRL / USDC", "R$5.472", "+0.12%"],
  ["ARS / USDC", "$1,338.42", "−0.07%"],
];

const anchors = [
  { name: "MoneyGram", place: "Global cash network", score: 98, rate: "1.0004", tone: "lime" },
  { name: "ClickPesa", place: "East Africa", score: 96, rate: "1.0021", tone: "cyan" },
  { name: "Cowrie", place: "Nigeria", score: 94, rate: "1.0058", tone: "violet" },
  { name: "Settle", place: "Latin America", score: 91, rate: "1.0086", tone: "amber" },
];

function BrandLogo() {
  return <Image className="brand-logo" src="/StellarCore-logo.png" alt="" width={135} height={128} priority aria-hidden="true" />;
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Navbar() {
  return (
    <header className="navbar" data-nav>
      <a className="brand" href="#top" aria-label="StellarCore home">
        <BrandLogo />StellarCore
      </a>
      <nav aria-label="Primary navigation">
        <a href="#system">System</a>
        <a href="#anchors">Anchors</a>
        <a href="#network">Network</a>
      </nav>
      <a className="nav-cta" href="#anchors">
        Explore live rates <Arrow />
      </a>
    </header>
  );
}

function NetworkMap() {
  return (
    <div className="network-map" aria-label="Animated illustration of active Stellar corridors">
      <div className="map-glow" />
      <svg viewBox="0 0 1200 420" role="img" aria-label="Abstract global settlement network">
        <g className="map-grid" aria-hidden="true">
          {Array.from({ length: 18 }).map((_, index) => (
            <line key={`v-${index}`} x1={index * 72} y1="0" x2={index * 72} y2="420" />
          ))}
          {Array.from({ length: 7 }).map((_, index) => (
            <line key={`h-${index}`} x1="0" y1={index * 70} x2="1200" y2={index * 70} />
          ))}
        </g>
        <path className="land land-a" d="M58 104l82-37 74 17 38 49-43 27-10 66-52 14-50-38-53-21z" />
        <path className="land land-b" d="M306 250l54-27 64 22 35 47-30 69-58 35-37-68z" />
        <path className="land land-c" d="M522 90l72-30 93 20 46 44-23 47-69 12-26 66-53-16-36-69z" />
        <path className="land land-d" d="M723 94l94-31 127 30 102 57-36 42-78-3-48 61-69-20-31-62-67-26z" />
        <path className="land land-e" d="M961 281l68-23 72 32 18 61-50 40-90-23z" />
        <path id="corridor-main" className="corridor corridor-main" d="M205 153 C 398 22, 652 34, 834 151" />
        <path className="corridor corridor-echo" d="M381 284 C 487 184, 714 159, 1018 316" />
        <circle className="node node-a" cx="205" cy="153" r="6" />
        <circle className="node node-b" cx="834" cy="151" r="6" />
        <circle className="node node-c" cx="381" cy="284" r="5" />
        <circle className="node node-d" cx="1018" cy="316" r="5" />
        <circle className="flow-dot" cx="0" cy="0" r="7" />
      </svg>
      <span className="map-label label-west">United States · USD</span>
      <span className="map-label label-east">Nigeria · NGN</span>
      <div className="route-readout">
        <span>Best route now</span>
        <strong>0.31% total spread</strong>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-kicker reveal-item">
        <span>Execution intelligence</span>
        <span>Built on Stellar</span>
      </div>
      <h1 className="hero-title" data-hero-title>
        STELLARCORE
      </h1>
      <div className="hero-bottom reveal-item">
        <p>Know the route before you move the value.</p>
        <div className="live-count"><i /> <strong data-count>27</strong> anchors reporting</div>
      </div>
      <NetworkMap />
      <a className="scroll-cue reveal-item" href="#rates" aria-label="Scroll to live rates">
        <span>Scroll to inspect</span>
        <i />
      </a>
    </section>
  );
}

function RateTicker() {
  const stream = [...rates, ...rates];
  return (
    <section className="rate-section" id="rates" aria-label="Current sample rates">
      <div className="section-intro">
        <span className="eyebrow">Signal, not noise</span>
        <p>Live corridor pricing, normalized into one legible view.</p>
      </div>
      <div className="ticker-window">
        <div className="ticker-track">
          {stream.map(([pair, value, delta], index) => (
            <article className="rate-item" key={`${pair}-${index}`}>
              <span>{pair}</span>
              <strong>{value}</strong>
              <small className={delta.startsWith("+") ? "positive" : "negative"}>{delta}</small>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SystemSection() {
  const steps = [
    ["01", "Discover", "Read the network", "We resolve anchor metadata and supported standards into a continuously updated directory."],
    ["02", "Compare", "See the real price", "Quotes are normalized across currencies, fees and settlement paths so every route is comparable."],
    ["03", "Decide", "Move with context", "Reputation, freshness and historical behavior sit beside the rate—not hidden behind it."],
  ];
  return (
    <section className="system-section" id="system">
      <div className="system-heading">
        <span className="eyebrow">One network. Clearer decisions.</span>
        <h2><span data-scramble>Infrastructure,</span><br /><em data-scramble>made visible.</em></h2>
        <p>StellarCore turns fragmented anchor signals into a shared execution layer.</p>
      </div>
      <div className="system-steps">
        {steps.map(([number, verb, title, copy]) => (
          <article className="system-step" key={number}>
            <div className="step-top"><span>{number}</span><span>{verb}</span></div>
            <div className="step-orbit" aria-hidden="true"><i /><i /><i /></div>
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Gauge({ score }: { score: number }) {
  const circumference = 2 * Math.PI * 52;
  return (
    <div className="gauge" style={{ "--score": score } as React.CSSProperties}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="gauge-track" cx="60" cy="60" r="52" />
        <circle className="gauge-value" cx="60" cy="60" r="52" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - score / 100)} />
      </svg>
      <div><strong>{score}</strong><span>/100</span></div>
    </div>
  );
}

function AnchorsSection() {
  return (
    <section className="anchors-section" id="anchors">
      <div className="anchors-heading">
        <span className="eyebrow">Reputation in context</span>
        <h2><span data-scramble>Trust is a</span><br /><span data-scramble>track record.</span></h2>
        <a href="#network">View the directory <Arrow /></a>
      </div>
      <div className="anchor-track">
        {anchors.map((anchor, index) => (
          <article className={`anchor-card ${anchor.tone}`} key={anchor.name}>
            <div className="card-index">0{index + 1}</div>
            <div className="anchor-symbol" aria-hidden="true"><span /><span /><span /></div>
            <div className="anchor-copy">
              <span>{anchor.place}</span>
              <h3>{anchor.name}</h3>
            </div>
            <div className="anchor-metrics">
              <Gauge score={anchor.score} />
              <div><span>Best quote</span><strong>{anchor.rate}</strong><small>USDC</small></div>
            </div>
            <div className="card-footer"><span><i /> Live</span><span>SEP-24 · SEP-38</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function StatsFooter() {
  return (
    <section className="stats-section" id="network">
      <div className="stats-copy">
        <span className="eyebrow">The network at a glance</span>
        <h2><span data-scramble>Every signal.</span><br /><span data-scramble>One core.</span></h2>
      </div>
      <div className="stats-grid">
        <div><strong data-stat="27">0</strong><span>Active anchors</span></div>
        <div><strong data-stat="84">0</strong><span>Open corridors</span></div>
        <div><strong data-stat="12.4">0</strong><small>M</small><span>Rate observations</span></div>
        <div><strong data-stat="99.98">0</strong><small>%</small><span>Data uptime</span></div>
      </div>
      <div className="closing-cta">
        <p><span data-scramble>The shortest route starts</span><br /><span data-scramble>with a clearer view.</span></p>
        <a href="#top">Enter the network <Arrow /></a>
      </div>
      <footer>
        <a className="brand" href="#top"><BrandLogo /> StellarCore</a>
        <p>Open intelligence for an open financial network.</p>
        <div><a href="#system">Documentation</a><a href="#anchors">GitHub</a><a href="#rates">API</a></div>
        <span>Concept frontend · 2026</span>
      </footer>
    </section>
  );
}

function Cursor() {
  return <div className="cursor" aria-hidden="true"><span>View</span></div>;
}

export function LandingPage() {
  const root = useRef<HTMLElement>(null);

  useGSAP(() => {
    const mm = gsap.matchMedia();

    mm.add({
      motion: "(prefers-reduced-motion: no-preference)",
      desktop: "(min-width: 900px)",
    }, (context) => {
      const { motion, desktop } = context.conditions as { motion: boolean; desktop: boolean };
      if (!motion) {
        gsap.set("[data-nav], .reveal-item", { autoAlpha: 1 });
        return;
      }

      const scrambleVars = {
        text: "{original}",
        chars: "STELLARCORE0123456789",
        speed: 0.65,
        revealDelay: 0.08,
        tweenLength: false,
      };

      const introText = gsap.utils.toArray<HTMLElement>(
        ".hero h1, .hero-kicker span, .hero-bottom p, .hero-bottom strong, .navbar nav a, .nav-cta",
      );
      const intro = gsap.timeline({ defaults: { ease: "power4.out" } });
      intro
        .to(introText, { duration: 0.95, scrambleText: scrambleVars, stagger: 0.045 })
        .from(".network-map", { scale: 0.92, autoAlpha: 0, duration: 1.2 }, "-=0.7")
        .from(".reveal-item", { y: 18, autoAlpha: 0, duration: 0.7, stagger: 0.08 }, "-=0.65")
        .from("[data-nav]", { y: -20, autoAlpha: 0, duration: 0.7 }, "-=0.5");

      const scrollText = gsap.utils.toArray<HTMLElement>([
        "[data-scramble]",
        ".rate-section .eyebrow",
        ".section-intro p",
        ".rate-item > *",
        ".system-section .eyebrow",
        ".system-heading p",
        ".step-top span",
        ".system-step h3",
        ".system-step > p",
        ".anchors-section .eyebrow",
        ".anchor-copy > *",
        ".anchor-metrics > div:last-child > *",
        ".card-footer span:last-child",
        ".stats-section .eyebrow",
        ".stats-grid span",
        "footer p",
        "footer > div a",
        "footer > span",
      ].join(", ")).filter((element) => element.childElementCount === 0 && !element.matches("[data-stat]"));

      scrollText.forEach((element) => {
        gsap.to(element, {
          duration: 0.85,
          ease: "none",
          scrambleText: scrambleVars,
          scrollTrigger: { trigger: element, start: "top 88%", once: true },
        });
      });

      gsap.fromTo(".corridor-main", { strokeDasharray: 900, strokeDashoffset: 900 }, { strokeDashoffset: 0, duration: 1.6, ease: "power2.inOut", delay: 0.65 });
      gsap.to(".flow-dot", {
        motionPath: { path: "#corridor-main", align: "#corridor-main", alignOrigin: [0.5, 0.5] },
        duration: 3.2,
        ease: "none",
        repeat: -1,
        delay: 1.2,
      });
      gsap.to(".ticker-track", { xPercent: -50, duration: 25, repeat: -1, ease: "none" });

      gsap.utils.toArray<HTMLElement>(".system-step").forEach((step) => {
        gsap.from(step.children, {
          y: 44,
          autoAlpha: 0,
          stagger: 0.08,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: { trigger: step, start: "top 78%", once: true },
        });
      });

      gsap.from(".gauge-value", {
        strokeDashoffset: 327,
        duration: 1.1,
        stagger: 0.1,
        ease: "power3.out",
        scrollTrigger: { trigger: ".anchors-section", start: "top 58%", once: true },
      });

      if (desktop) {
        const track = document.querySelector<HTMLElement>(".anchor-track");
        if (track) {
          gsap.to(track, {
            x: () => Math.min(0, window.innerWidth - track.scrollWidth - 48),
            ease: "none",
            scrollTrigger: {
              trigger: ".anchors-section",
              start: "top top",
              end: () => `+=${Math.max(900, track.scrollWidth - window.innerWidth + 550)}`,
              scrub: 0.8,
              pin: true,
              invalidateOnRefresh: true,
            },
          });
        }

        const cursor = document.querySelector<HTMLElement>(".cursor");
        if (cursor) {
          const xTo = gsap.quickTo(cursor, "x", { duration: 0.35, ease: "power3.out" });
          const yTo = gsap.quickTo(cursor, "y", { duration: 0.35, ease: "power3.out" });
          const move = (event: PointerEvent) => { xTo(event.clientX); yTo(event.clientY); };
          window.addEventListener("pointermove", move);
          const interactive = gsap.utils.toArray<HTMLElement>("a, .anchor-card");
          const enter = () => cursor.classList.add("is-active");
          const leave = () => cursor.classList.remove("is-active");
          interactive.forEach((item) => { item.addEventListener("pointerenter", enter); item.addEventListener("pointerleave", leave); });
          return () => {
            window.removeEventListener("pointermove", move);
            interactive.forEach((item) => { item.removeEventListener("pointerenter", enter); item.removeEventListener("pointerleave", leave); });
          };
        }
      }

      document.querySelectorAll<HTMLElement>("[data-stat]").forEach((element) => {
        const target = Number(element.dataset.stat);
        const counter = { value: 0 };
        gsap.to(counter, {
          value: target,
          duration: 1.8,
          ease: "power3.out",
          scrollTrigger: { trigger: element, start: "top 86%", once: true },
          onUpdate: () => { element.textContent = target % 1 ? counter.value.toFixed(target === 99.98 ? 2 : 1) : Math.round(counter.value).toString(); },
        });
      });
    });

    return () => mm.revert();
  }, { scope: root });

  return (
    <main ref={root}>
      <Navbar />
      <Hero />
      <RateTicker />
      <SystemSection />
      <AnchorsSection />
      <StatsFooter />
      <div className="grain" aria-hidden="true" />
      <Cursor />
    </main>
  );
}
