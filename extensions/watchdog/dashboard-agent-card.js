// dashboard-agent-card.js — Geometry helpers for graph agent card lanes.

export class AgentCardView {
  constructor({ agentId, position, nodePositions = {}, graphEdges = [] }) {
    this.agentId = agentId;
    this.position = position;
    this.nodePositions = nodePositions && typeof nodePositions === 'object' ? nodePositions : {};
    this.graphEdges = Array.isArray(graphEdges) ? graphEdges : [];
  }

  getDirectionForLane(lane, targetAgent = null) {
    const edge = this.findRelevantEdge(lane, targetAgent);
    const fallbackEdge = edge || this.inferEdgeFromLaneTarget(lane, targetAgent);
    if (!fallbackEdge) return 'left_to_right';
    const from = this.positionFor(fallbackEdge.from);
    const to = this.positionFor(fallbackEdge.to);
    if (!from || !to) return 'left_to_right';
    return (from.x + from.w / 2) <= (to.x + to.w / 2)
      ? 'left_to_right'
      : 'right_to_left';
  }

  laneAnchor(lane, targetAgent = null) {
    const pos = this.position;
    const direction = this.getDirectionForLane(lane, targetAgent);
    const incomingOnLeft = direction === 'left_to_right';
    const isIncoming = lane === 'incoming';
    const isOutgoing = lane === 'outgoing';
    const isRunning = lane === 'running';
    const topY = pos.y - 28;
    const side = isIncoming
      ? (incomingOnLeft ? 'left' : 'right')
      : isOutgoing
        ? (incomingOnLeft ? 'right' : 'left')
        : 'center';

    if (side === 'left') return { x: pos.x + 8, y: topY, side, direction };
    if (side === 'right') return { x: pos.x + pos.w - 70, y: topY, side, direction };
    if (isRunning) return { x: pos.x + pos.w / 2 - 9, y: topY, side, direction };
    return { x: pos.x + pos.w / 2 - 9, y: topY, side, direction };
  }

  positionFor(agentId) {
    return this.nodePositions[agentId] || null;
  }

  findRelevantEdge(lane, targetAgent = null) {
    if (lane === 'outgoing' && targetAgent) {
      return this.graphEdges.find((edge) => edge.from === this.agentId && edge.to === targetAgent) || null;
    }
    if (lane === 'incoming' && targetAgent) {
      return this.graphEdges.find((edge) => edge.from === targetAgent && edge.to === this.agentId) || null;
    }
    if (lane === 'incoming') {
      return this.graphEdges.find((edge) => edge.to === this.agentId)
        || this.graphEdges.find((edge) => edge.from === this.agentId)
        || null;
    }
    return null;
  }

  inferEdgeFromLaneTarget(lane, targetAgent = null) {
    if (!targetAgent || !this.positionFor(targetAgent) || !this.positionFor(this.agentId)) {
      return null;
    }
    if (lane === 'incoming') return { from: targetAgent, to: this.agentId };
    if (lane === 'outgoing') return { from: this.agentId, to: targetAgent };
    return null;
  }
}
