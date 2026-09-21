/** Files that belong to the project-wide ABAP analysis unit. Metadata matters:
 * abapGit splits classes, function groups and DDIC objects across source and XML
 * files, so a metadata edit must invalidate the same graph as a source edit. */
const ABAP_OBJECT_XML = /\.(?:clas|intf|prog|fugr|tabl|dtel|doma|ttyp|devc|sicf|tran)(?:\.[^.]+)?\.xml$/i;

export function isAbapFile(path: string): boolean {
  return /\.abap$/i.test(path) || ABAP_OBJECT_XML.test(path);
}
