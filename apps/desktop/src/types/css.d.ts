declare module "*.css" {
  const classes: { [selector: string]: string };
  export default classes;
}

declare module "@muyajs/core/lib/core.css" {
  const styles: Record<string, string>;
  export default styles;
}
