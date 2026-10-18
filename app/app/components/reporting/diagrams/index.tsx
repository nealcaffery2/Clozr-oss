'use client';

// One entry point for ReportBlocks: a 'diagram' block to the component that draws it.

import React from 'react';
import type { Block } from '@/lib/reporting';
import { FunnelDiagram } from './FunnelDiagram';
import { LeadFlowDiagram } from './LeadFlowDiagram';
import { DataFlowDiagram } from './DataFlowDiagram';
import { OrgChartDiagram } from './OrgChartDiagram';
import { PipelineDiagram } from './PipelineDiagram';
import { TimelineDiagram } from './TimelineDiagram';

export function DiagramBlock({ b }: { b: Extract<Block, { kind: 'diagram' }> }) {
  const p = { title: b.title, caption: b.sub, empty: b.empty };
  const d = b.diagram;
  switch (d.type) {
    case 'funnel': return <FunnelDiagram d={d} {...p} />;
    case 'leadflow': return <LeadFlowDiagram d={d} {...p} />;
    case 'dataflow': return <DataFlowDiagram d={d} {...p} />;
    case 'org': return <OrgChartDiagram d={d} {...p} />;
    case 'pipeline': return <PipelineDiagram d={d} {...p} />;
    case 'timeline': return <TimelineDiagram d={d} {...p} />;
  }
}
