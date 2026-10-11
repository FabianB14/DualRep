/**
 * The concept map's layout (pure): the selected card in the middle and the cards linked to it on an
 * ellipse around it, starting at the top and going clockwise. A simple fixed layout rather than a
 * physics simulation: it is stable (the same links always draw the same way), cheap, and needs no
 * package. At most MAP_MAX_NEIGHBORS cards are drawn; the list under the map always has them all.
 */
import { relationLabel } from './studyText';

/** Drawn around the middle card; more would overlap on a phone. The list shows the rest. */
export const MAP_MAX_NEIGHBORS = 6;

export type MapLink = {
  id: string;
  from_card_id: string;
  to_card_id: string;
  relation: string | null;
  other_card_id: string;
  other_question: string | null;
  created_by?: string | null;
};

export type MapNeighbor = {
  cardId: string;
  question: string;
  /** How it relates to the middle card, in plain words; one per distinct relation. */
  relations: string[];
  /** The links joining the two cards. */
  linkIds: string[];
};

/** The middle card's links grouped by the other card (two links between the same pair draw once). */
export function mapNeighbors(centerId: string, links: readonly MapLink[]): MapNeighbor[] {
  const byCard = new Map<string, MapNeighbor>();
  for (const link of links) {
    if (link.other_card_id === centerId) continue;
    const label = relationLabel(link.relation, link.from_card_id === centerId);
    const neighbor = byCard.get(link.other_card_id) ?? {
      cardId: link.other_card_id,
      question: link.other_question ?? '',
      relations: [],
      linkIds: [],
    };
    if (!neighbor.relations.includes(label)) neighbor.relations.push(label);
    neighbor.linkIds.push(link.id);
    byCard.set(link.other_card_id, neighbor);
  }
  return [...byCard.values()];
}

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/**
 * Where each count puts its nodes, in degrees clockwise from 3 o'clock (-90 = the top). The slots
 * avoid the band level with the middle card, where a side node would cover it on a narrow phone: four
 * cards go on the diagonals, five use six slots with one left empty.
 */
const SLOTS: Record<number, readonly number[]> = {
  1: [-90],
  2: [-90, 90],
  3: [-90, 30, 150],
  4: [-135, -45, 45, 135],
  5: [-90, -30, 30, 90, 150],
  6: [-90, -30, 30, 90, 150, 210],
};

/**
 * Centres of `count` nodes of `node` size around the middle of an area of `area` size: on an ellipse
 * that keeps every node inside the area, in reading order (top first, then clockwise). Only the
 * first MAP_MAX_NEIGHBORS are placed.
 */
export function radialLayout(count: number, area: Size, node: Size): Point[] {
  const n = Math.max(0, Math.min(MAP_MAX_NEIGHBORS, Math.floor(count)));
  if (n === 0) return [];
  const cx = area.width / 2;
  const cy = area.height / 2;
  const rx = Math.max(0, (area.width - node.width) / 2);
  const ry = Math.max(0, (area.height - node.height) / 2);
  return SLOTS[n].map((degrees) => {
    const angle = (degrees * Math.PI) / 180;
    return { x: round(cx + rx * Math.cos(angle)), y: round(cy + ry * Math.sin(angle)) };
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** True when two boxes centred at `a` and `b` overlap (the layout test uses it). */
export function boxesOverlap(a: Point, aSize: Size, b: Point, bSize: Size): boolean {
  return Math.abs(a.x - b.x) < (aSize.width + bSize.width) / 2 && Math.abs(a.y - b.y) < (aSize.height + bSize.height) / 2;
}

/** The map's sizes for a given width: tall enough that the nodes and the middle card never overlap. */
export function mapGeometry(width: number): { area: Size; node: Size; center: Size } {
  const w = Math.max(280, Math.round(width));
  // A node holds a relation line and three lines of 14 dp text (20 dp each) inside its padding; the
  // middle card four lines.
  const node = { width: Math.min(140, Math.round(w * 0.36)), height: 100 };
  const center = { width: Math.min(180, Math.round(w * 0.46)), height: 104 };
  // Nodes in the 30-degree slots sit half the vertical radius from the middle row and from the top
  // node: that gap must clear a node, and the middle card. (+4: a little air between them.)
  const ry = 2 * Math.max(node.height, (node.height + center.height) / 2) + 4;
  return { area: { width: w, height: 2 * ry + node.height }, node, center };
}
