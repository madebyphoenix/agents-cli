import {
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  AbsoluteFill,
  Audio,
  Sequence,
  Img,
  staticFile,
} from "remotion";
import { Terminal } from "./Terminal";
import { SCENES } from "./scenes";

const CRTOverlay: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        "repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0px, rgba(0,0,0,0.06) 1px, transparent 1px, transparent 3px)",
      zIndex: 100,
    }}
  />
);

const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)",
      zIndex: 99,
    }}
  />
);

// Finale: Phoenix logo + agents-cli wordmark + CTA.
const Finale: React.FC<{ frameInScene: number; fps: number }> = ({
  frameInScene,
  fps,
}) => {
  const logoSpring = spring({
    frame: frameInScene,
    fps,
    config: { damping: 14, stiffness: 100, mass: 0.8 },
  });
  const wordFade = interpolate(frameInScene, [20, 40], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const taglineFade = interpolate(frameInScene, [35, 55], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const ctaFade = interpolate(frameInScene, [55, 80], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const footerFade = interpolate(frameInScene, [75, 95], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const glowPulse =
    0.5 +
    0.5 *
      Math.sin(
        (frameInScene / fps) * 2 * Math.PI * 0.6,
      );

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
      }}
    >
      <div
        style={{
          width: 260,
          height: 260,
          position: "relative",
          transform: `scale(${logoSpring}) translateY(${(1 - logoSpring) * 20}px)`,
          opacity: logoSpring,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: -40,
            background: `radial-gradient(circle, rgba(163,230,53,${0.08 + glowPulse * 0.06}) 0%, transparent 65%)`,
            filter: "blur(20px)",
          }}
        />
        <Img
          src={staticFile("phoenix-logo.png")}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            position: "relative",
            filter: "drop-shadow(0 20px 40px rgba(0,0,0,0.6))",
          }}
        />
      </div>

      <div
        style={{
          opacity: wordFade,
          transform: `translateY(${(1 - wordFade) * 12}px)`,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 84,
          fontWeight: 500,
          letterSpacing: "-0.04em",
          color: "#f5f5f5",
          marginTop: 8,
        }}
      >
        agents
      </div>

      <div
        style={{
          opacity: taglineFade,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 20,
          color: "#888",
          letterSpacing: "0.02em",
          marginTop: -8,
        }}
      >
        the open client for AI coding agents
      </div>

      <div
        style={{
          opacity: ctaFade,
          transform: `translateY(${(1 - ctaFade) * 10}px)`,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 22,
          color: "#a3e635",
          marginTop: 32,
          padding: "14px 28px",
          border: "1px solid rgba(163,230,53,0.3)",
          borderRadius: 8,
          background: "rgba(163,230,53,0.04)",
        }}
      >
        $ curl -fsSL agents-cli.sh | sh
      </div>

      <div
        style={{
          opacity: footerFade,
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginTop: 36,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 15,
          color: "#555",
        }}
      >
        <span>github.com/phnx-labs/agents-cli</span>
        <span style={{ color: "#333" }}>·</span>
        <span>
          made by <span style={{ color: "#999" }}>phoenix</span>
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Main composition.
export const AgentsDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const sceneStarts: number[] = [];
  let acc = 0;
  for (const s of SCENES) {
    sceneStarts.push(acc);
    acc += s.durationFrames;
  }

  let currentSceneIdx = SCENES.length - 1;
  let sceneStartFrame = sceneStarts[sceneStarts.length - 1];
  for (let i = 0; i < SCENES.length; i++) {
    const next = sceneStarts[i] + SCENES[i].durationFrames;
    if (frame < next) {
      currentSceneIdx = i;
      sceneStartFrame = sceneStarts[i];
      break;
    }
  }

  const scene = SCENES[currentSceneIdx];
  const frameInScene = frame - sceneStartFrame;
  const isFinale = scene.id === "finale";

  const fadeIn = spring({
    frame: frameInScene,
    fps,
    config: { damping: 30, stiffness: 120 },
  });

  // Scenes that deserve a "positive" stinger when they resolve (after install / use / etc).
  const successScenes = new Set([
    "install",
    "use",
    "profile",
    "skills",
    "mcp",
    "cloud",
  ]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(163,230,53,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(163,230,53,0.02) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
          opacity: 0.5,
        }}
      />

      {isFinale ? (
        <Finale frameInScene={frameInScene} fps={fps} />
      ) : (
        <AbsoluteFill
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: fadeIn,
            transform: `translateY(${(1 - fadeIn) * 15}px)`,
          }}
        >
          <Terminal
            lines={scene.lines}
            sceneStartFrame={sceneStartFrame}
            prompt={scene.prompt}
          />
        </AbsoluteFill>
      )}

      <CRTOverlay />
      <Vignette />

      {/* Background music — fades handled in the mp3 itself. */}
      <Audio src={staticFile("music.mp3")} volume={0.55} />

      {/* Per-scene transition stinger at each scene start (skip scene 0 to avoid hit at t=0). */}
      {SCENES.map((s, i) =>
        i === 0 ? null : (
          <Sequence
            key={`t-${s.id}`}
            from={sceneStarts[i]}
            durationInFrames={20}
          >
            <Audio src={staticFile("sfx-transition.mp3")} volume={0.25} />
          </Sequence>
        ),
      )}

      {/* Success chirp ~2/3 into scenes with a successful command output. */}
      {SCENES.map((s, i) =>
        successScenes.has(s.id) ? (
          <Sequence
            key={`s-${s.id}`}
            from={sceneStarts[i] + Math.floor(s.durationFrames * 0.55)}
            durationInFrames={45}
          >
            <Audio
              src={staticFile("sfx-success.mp3")}
              volume={0.18}
              endAt={45}
            />
          </Sequence>
        ) : null,
      )}

      {/* Keystroke tick on prompt appearance for each scene. */}
      {SCENES.map((s, i) => (
        <Sequence
          key={`k-${s.id}`}
          from={sceneStarts[i] + 2}
          durationInFrames={12}
        >
          <Audio src={staticFile("sfx-keystroke.mp3")} volume={0.3} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
