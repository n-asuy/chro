export interface TableCell {
  content: string;
  from: number;
  to: number;
  isHeader: boolean;
  align?: "left" | "center" | "right";
}

export interface TableRow {
  cells: TableCell[];
  from: number;
  to: number;
  isHeader: boolean;
  isDelimiter: boolean;
}

export interface TableInfo {
  rows: TableRow[];
  from: number;
  to: number;
  alignments: ("left" | "center" | "right" | undefined)[];
}
