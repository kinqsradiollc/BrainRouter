/**
 * Atlas guided-tour overlay — a floating card that walks the enriched graph's
 * tour steps (title + description + prev/next). Extracted from AtlasPanel so the
 * panel stays thin; the step's nodes are pulsed on the canvas by the panel.
 */
import React from "react";
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { Icon } from "../../icons.js";

export interface AtlasTourProps {
  graph: AtlasGraph;
  tourStep: number;
  setTourStep: (step: number | null) => void;
}

export function AtlasTour({ graph, tourStep, setTourStep }: AtlasTourProps): React.ReactElement {
  return (
    <div className="atlas-tour">
      <div className="atlas-tour-top">
        <span className="atlas-tour-progress">Step {tourStep + 1} of {graph.tour.length}</span>
        <button className="atlas-detail-x" aria-label="Exit tour" title="Exit tour" onClick={() => setTourStep(null)}><Icon name="close" size={11} /></button>
      </div>
      <div className="atlas-tour-title">{graph.tour[tourStep].title}</div>
      <div className="atlas-tour-desc">{graph.tour[tourStep].description}</div>
      <div className="atlas-tour-nav">
        <button className="btn" disabled={tourStep === 0} onClick={() => setTourStep(Math.max(0, tourStep - 1))}>Prev</button>
        {tourStep < graph.tour.length - 1
          ? <button className="btn primary" onClick={() => setTourStep(tourStep + 1)}>Next</button>
          : <button className="btn primary" onClick={() => setTourStep(null)}>Done</button>}
      </div>
    </div>
  );
}
