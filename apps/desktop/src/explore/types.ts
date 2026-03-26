export type NodeType = "note" | "tag" | "attachment";

export type LinkType = "link" | "embed" | "tag" | "frontmatter";

export interface GraphNode {
  id: string;
  title: string;
  relativePath: string;
  type: NodeType;
  backlinkCount: number;
  tags?: string[];
}

export interface GraphLink {
  source: string;
  target: string;
  strength: number;
  type: LinkType;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface LinkReference {
  target: string;
  type: LinkType;
}
