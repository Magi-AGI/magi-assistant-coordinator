declare module 'tree-kill' {
  function treeKill(pid: number, signal?: string, callback?: (err?: Error) => void): void;
  export default treeKill;
}
