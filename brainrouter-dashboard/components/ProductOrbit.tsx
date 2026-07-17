"use client";

import { useEffect, useRef } from "react";
import type { BufferGeometry, Material, Object3D, Scene, Texture, WebGLRenderer } from "three";
import styles from "./productOrbit.module.css";

const OPERATION_NODES = [
  { slot: "workbench", label: "Agent workbench", detail: "plan · build" },
  { slot: "sources", label: "Connected sources", detail: "repos · tools" },
  { slot: "knowledge", label: "Knowledge", detail: "memory · evidence" },
  { slot: "testing", label: "Security tests", detail: "checks · pentests" },
  { slot: "reviews", label: "PR reviews", detail: "findings · fixes" },
  { slot: "automation", label: "Automation", detail: "hooks · schedules" },
] as const;

type DisposableObject = Object3D & {
  geometry?: BufferGeometry;
  material?: Material | Material[];
};

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value) (value as Texture).dispose();
  }
  material.dispose();
}

function disposeScene(scene: Scene, renderer: WebGLRenderer): void {
  scene.traverse((object) => {
    const disposable = object as DisposableObject;
    disposable.geometry?.dispose();
    if (Array.isArray(disposable.material)) disposable.material.forEach(disposeMaterial);
    else if (disposable.material) disposeMaterial(disposable.material);
  });
  renderer.dispose();
}

/** Evenly distributed unit-sphere points (fibonacci lattice). */
function spherePoints(count: number, radius: number, jitter = 0): Float32Array {
  const positions = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / Math.max(count - 1, 1)) * 2;
    const r = Math.sqrt(Math.max(1 - y * y, 0));
    const angle = golden * index;
    const wobble = 1 + (jitter ? (Math.sin(index * 12.9898) * 43758.5453 % 1) * jitter : 0);
    positions[index * 3] = Math.cos(angle) * r * radius * wobble;
    positions[index * 3 + 1] = y * radius * wobble;
    positions[index * 3 + 2] = Math.sin(angle) * r * radius * wobble;
  }
  return positions;
}

export function ProductOrbit({ compact = false }: { compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let cancelled = false;
    let teardown = () => undefined;

    void (async () => {
      try {
        const [THREE, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/postprocessing/EffectComposer.js"),
          import("three/examples/jsm/postprocessing/RenderPass.js"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
          import("three/examples/jsm/postprocessing/OutputPass.js"),
        ]);
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x05060b, 0.055);
        const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80);
        const cameraDistance = compact ? 10.2 : 9.3;
        camera.position.set(0, 0.35, cameraDistance);

        // Restrained grade: only genuinely bright pixels bloom, and only a little.
        // Diffuse glow reads dated; precision reads futuristic.
        const composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.32, 0.32);
        composer.addPass(bloom);
        composer.addPass(new OutputPass());

        const root = new THREE.Group();
        root.rotation.set(-0.16, -0.1, 0.04);
        scene.add(root);

        // Monochrome family: cool silver particles, one violet accent. No rainbow.
        const SILVER = 0xdfe3ff;
        const VIOLET = 0x8b7cff;
        const DIM = 0x6f74a8;

        // ── The router core: a particle constellation, not a solid blob. ──
        // ~1.3k lattice points on a sphere + hair-thin links between near
        // neighbors — a precise "neural" structure that slowly self-rotates.
        const CORE_POINTS = 1280;
        const CORE_RADIUS = 1.42;
        const corePositions = spherePoints(CORE_POINTS, CORE_RADIUS, 0.015);
        const core = new THREE.Group();
        root.add(core);

        const coreGeometry = new THREE.BufferGeometry();
        coreGeometry.setAttribute("position", new THREE.BufferAttribute(corePositions, 3));
        const coreParticles = new THREE.Points(
          coreGeometry,
          new THREE.PointsMaterial({ color: SILVER, size: 0.024, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
        );
        core.add(coreParticles);

        // Plexus links: connect lattice neighbors within a small arc distance.
        const linkVertices: number[] = [];
        const maxLink = 0.34;
        for (let a = 0; a < CORE_POINTS; a += 1) {
          // The fibonacci lattice puts spatial neighbors at small index offsets
          // (±1..±21 windows) — enough to plexus without O(n²) search.
          for (const offset of [1, 2, 3, 8, 13, 21]) {
            const b = a + offset;
            if (b >= CORE_POINTS) continue;
            const dx = corePositions[a * 3] - corePositions[b * 3];
            const dy = corePositions[a * 3 + 1] - corePositions[b * 3 + 1];
            const dz = corePositions[a * 3 + 2] - corePositions[b * 3 + 2];
            if (dx * dx + dy * dy + dz * dz < maxLink * maxLink) {
              linkVertices.push(
                corePositions[a * 3], corePositions[a * 3 + 1], corePositions[a * 3 + 2],
                corePositions[b * 3], corePositions[b * 3 + 1], corePositions[b * 3 + 2],
              );
            }
          }
        }
        const linkGeometry = new THREE.BufferGeometry();
        linkGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(linkVertices), 3));
        const coreLinks = new THREE.LineSegments(
          linkGeometry,
          new THREE.LineBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        core.add(coreLinks);

        // Sparse counter-rotating outer shell — depth without bulk.
        const shellGeometry = new THREE.BufferGeometry();
        shellGeometry.setAttribute("position", new THREE.BufferAttribute(spherePoints(240, 2.05, 0.06), 3));
        const shell = new THREE.Points(
          shellGeometry,
          new THREE.PointsMaterial({ color: DIM, size: 0.016, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
        );
        root.add(shell);

        // Faint violet heart so the constellation has a center of gravity.
        const heart = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 24, 16),
          new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        root.add(heart);

        // ── Two precise orbital arcs (hair-thin, additive). ──
        const ringConfigs = [
          { radius: 2.65, x: 1.18, y: 0.1, z: 0.3, opacity: 0.22 },
          { radius: 3.25, x: 0.38, y: 1.05, z: -0.2, opacity: 0.16 },
        ];
        const rings = ringConfigs.map((config) => {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(config.radius, 0.0045, 6, 220),
            new THREE.MeshBasicMaterial({ color: SILVER, transparent: true, opacity: config.opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          ring.rotation.set(config.x, config.y, config.z);
          root.add(ring);
          return ring;
        });

        const nodePositions = [
          new THREE.Vector3(-3.25, 2.05, 0.1),
          new THREE.Vector3(3.35, 1.82, -0.45),
          new THREE.Vector3(-3.48, -0.5, 0.3),
          new THREE.Vector3(3.28, -1.78, 0.45),
          new THREE.Vector3(-2.42, -2.42, -0.38),
          new THREE.Vector3(2.82, 0.04, 0.72),
        ];
        // Data packets ride hair-thin arcs. Monochrome: silver packets, violet arcs.
        const TAIL = 5;
        const pulses: Array<{
          head: InstanceType<typeof THREE.Mesh>;
          tail: Array<InstanceType<typeof THREE.Mesh>>;
          curve: InstanceType<typeof THREE.QuadraticBezierCurve3>;
          offset: number;
          speed: number;
        }> = [];

        nodePositions.forEach((position, index) => {
          const lift = new THREE.Vector3(position.y * 0.2, -position.x * 0.14, 0.8 + (index % 3) * 0.24);
          const control = position.clone().multiplyScalar(0.5).add(lift);
          const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, position);
          const conduit = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 44, 0.0042, 6, false),
            new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          root.add(conduit);

          // Endpoint: a small precise marker — bright point + thin halo ring.
          const node = new THREE.Mesh(
            new THREE.SphereGeometry(0.045, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
          );
          node.position.copy(position);
          root.add(node);
          const nodeRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.11, 0.0045, 6, 40),
            new THREE.MeshBasicMaterial({ color: SILVER, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          nodeRing.position.copy(position);
          nodeRing.lookAt(camera.position);
          root.add(nodeRing);

          const head = new THREE.Mesh(
            new THREE.SphereGeometry(0.032, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
          );
          root.add(head);
          const tail = Array.from({ length: TAIL }, (_, tailIndex) => {
            const segment = new THREE.Mesh(
              new THREE.SphereGeometry(0.02 - tailIndex * 0.0026, 8, 6),
              new THREE.MeshBasicMaterial({ color: SILVER, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
            );
            root.add(segment);
            return segment;
          });
          pulses.push({ head, tail, curve, offset: index / nodePositions.length, speed: 0.12 + (index % 3) * 0.02 });
        });

        // Ambient dust — two sparse depth layers, barely-there.
        const makeDust = (count: number, spread: number, size: number, opacity: number) => {
          const positions = new Float32Array(count * 3);
          for (let index = 0; index < count; index += 1) {
            const angle = index * 2.399963;
            const radius = 2.4 + ((index * 47) % 1000) / (1000 / spread);
            positions[index * 3] = Math.cos(angle) * radius;
            positions[index * 3 + 1] = Math.sin(angle * 1.37) * radius * 0.62;
            positions[index * 3 + 2] = -3.4 + ((index * 31) % 900) / 150;
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          const points = new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ color: DIM, size, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }),
          );
          scene.add(points);
          return points;
        };
        const dustNear = makeDust(220, 3.6, 0.02, 0.4);
        const dustFar = makeDust(380, 5.4, 0.013, 0.26);

        let frame = 0;
        let visible = true;
        let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let pointerX = 0;
        let pointerY = 0;

        const resize = () => {
          const width = Math.max(host.clientWidth, 1);
          const height = Math.max(host.clientHeight, 1);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
          renderer.setSize(width, height, false);
          composer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          composer.render();
        };

        const renderFrame = (now: number) => {
          frame = 0;
          if (!visible || reducedMotion) return;
          const time = now * 0.001;
          // Slow dolly drift + pointer parallax; precision, not spectacle.
          camera.position.x = Math.sin(time * 0.045) * 0.5 + pointerX * 0.32;
          camera.position.y = 0.35 + Math.sin(time * 0.1) * 0.16 - pointerY * 0.26;
          camera.position.z = cameraDistance + Math.sin(time * 0.065) * 0.22;
          camera.lookAt(0, 0, 0);
          root.rotation.y = -0.1 + time * 0.018 + pointerX * 0.05;
          core.rotation.y = time * 0.11;
          core.rotation.x = Math.sin(time * 0.3) * 0.05;
          shell.rotation.y = -time * 0.07;
          heart.scale.setScalar(1 + Math.sin(time * 1.1) * 0.06);
          rings[0].rotation.z = ringConfigs[0].z + time * 0.07;
          rings[1].rotation.z = ringConfigs[1].z - time * 0.05;
          dustNear.rotation.z = time * 0.008;
          dustFar.rotation.z = -time * 0.005;
          for (const pulse of pulses) {
            const progress = (time * pulse.speed + pulse.offset) % 1;
            const intensity = Math.sin(progress * Math.PI);
            pulse.head.position.copy(pulse.curve.getPoint(progress));
            pulse.head.scale.setScalar(0.8 + intensity * 0.5);
            (pulse.head.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = intensity * 0.95;
            pulse.tail.forEach((segment, tailIndex) => {
              const trail = Math.max(progress - (tailIndex + 1) * 0.024, 0);
              segment.position.copy(pulse.curve.getPoint(trail));
              (segment.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity =
                intensity * Math.max(0.4 - tailIndex * 0.07, 0) * (trail > 0 ? 1 : 0);
            });
          }
          composer.render();
          frame = window.requestAnimationFrame(renderFrame);
        };
        const startAnimation = () => {
          if (!frame && visible && !reducedMotion) frame = window.requestAnimationFrame(renderFrame);
        };
        const stopAnimation = () => {
          if (frame) window.cancelAnimationFrame(frame);
          frame = 0;
        };

        const onPointerMove = (event: PointerEvent) => {
          const bounds = host.getBoundingClientRect();
          pointerX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1) - 0.5) * 2;
          pointerY = ((event.clientY - bounds.top) / Math.max(bounds.height, 1) - 0.5) * 2;
        };
        const onPointerLeave = () => { pointerX = 0; pointerY = 0; };
        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        const onMotionChange = (event: MediaQueryListEvent) => {
          reducedMotion = event.matches;
          if (reducedMotion) {
            stopAnimation();
            composer.render(); // one graded still frame, no motion
          } else startAnimation();
        };
        const onContextLost = (event: Event) => {
          event.preventDefault();
          stopAnimation();
          host.dataset.render = "fallback";
        };
        const onContextRestored = () => {
          host.dataset.render = "webgl";
          resize();
          startAnimation();
        };

        const resizeObserver = new ResizeObserver(resize);
        const visibilityObserver = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
          if (visible) startAnimation();
          else stopAnimation();
        }, { rootMargin: "120px" });
        resizeObserver.observe(host);
        visibilityObserver.observe(host);
        host.addEventListener("pointermove", onPointerMove, { passive: true });
        host.addEventListener("pointerleave", onPointerLeave, { passive: true });
        canvas.addEventListener("webglcontextlost", onContextLost);
        canvas.addEventListener("webglcontextrestored", onContextRestored);
        motionQuery.addEventListener("change", onMotionChange);
        host.dataset.render = "webgl";
        resize();
        startAnimation();

        teardown = () => {
          stopAnimation();
          resizeObserver.disconnect();
          visibilityObserver.disconnect();
          host.removeEventListener("pointermove", onPointerMove);
          host.removeEventListener("pointerleave", onPointerLeave);
          canvas.removeEventListener("webglcontextlost", onContextLost);
          canvas.removeEventListener("webglcontextrestored", onContextRestored);
          motionQuery.removeEventListener("change", onMotionChange);
          bloom.dispose();
          composer.dispose();
          disposeScene(scene, renderer);
        };
      } catch {
        host.dataset.render = "fallback";
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [compact]);

  return (
    <div
      ref={hostRef}
      className={`${styles.scene}${compact ? ` ${styles.compact}` : ""}`}
      data-testid="product-orbit"
      data-render="loading"
      role="img"
      aria-label="Three-dimensional BrainRouter operations graph connecting the agent workbench, sources, knowledge, security tests, pull request reviews, and automation through shared task state."
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.fallbackCore} aria-hidden="true"><i /><i /><i /></div>
      <div className={styles.scanline} aria-hidden="true" />

      <div className={styles.sceneHeader} aria-hidden="true">
        <span><i /> Operations graph</span>
        <small>live · shared state</small>
      </div>

      <div className={styles.coreLabel} aria-hidden="true">
        <span>BR / CORE</span>
        <strong>Agent operations</strong>
        <small>shared task router</small>
      </div>

      <div className={styles.nodes} aria-hidden="true">
        {OPERATION_NODES.map((node) => (
          <span key={node.slot} className={styles.node} data-slot={node.slot}>
            <i />{node.label}<small>{node.detail}</small>
          </span>
        ))}
      </div>

      <div className={styles.activityRail} aria-hidden="true">
        <span data-signal="review"><i />PR review ready</span>
        <span data-signal="test"><i />test suite passed</span>
        <span data-signal="context"><i />context synchronized</span>
      </div>
    </div>
  );
}
