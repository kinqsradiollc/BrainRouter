/**
 * Freeform Canvas editor — document + layer model. Pure types (no React) shared
 * by the renderer (buildEditorSVG) and the editor UI.
 */

import type { LockupKey } from "../brandPresets";

export type LayerType = "text" | "image" | "logo" | "shape";

interface BaseLayer {
  id: string;
  type: LayerType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
}

export interface TextLayer extends BaseLayer {
  type: "text";
  text: string;
  fontFamily: "sans" | "mono";
  fontSize: number;
  weight: number;
  color: string;
  align: "left" | "center" | "right";
  letterSpacing: number;
  lineHeight: number;
  effect: "none" | "shadow" | "outline";
  effectColor: string;
}

export interface ImageLayer extends BaseLayer {
  type: "image";
  src: string;
  radius: number;
}

export interface LogoLayer extends BaseLayer {
  type: "logo";
  lockup: LockupKey;
  color: string;
}

export interface ShapeLayer extends BaseLayer {
  type: "shape";
  shape: "rect" | "ellipse" | "line";
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}

export type Layer = TextLayer | ImageLayer | LogoLayer | ShapeLayer;

export interface Background {
  type: "solid" | "gradient" | "grid" | "rosette" | "transparent" | "image";
  color: string;
  from: string;
  to: string;
  angle: number;
  accent: string;
  src: string | null;
}

export interface EditorDoc {
  width: number;
  height: number;
  background: Background;
  layers: Layer[];
}
