import sax from 'sax';

interface ProjectDeclarations {
  sdk?: string;
  targetFramework?: string;
  targetFrameworks?: string;
  outputType?: string;
  isWpf: boolean;
  isWinUi: boolean;
  isWinForms: boolean;
  projectReferences: string[];
  solutionProjects: string[];
}

const properties = new Set(['targetframework', 'targetframeworks', 'outputtype', 'usewpf', 'usewinui', 'usewindowsforms']);

/** Read a bounded descriptor as declarations only. Conditions and imports are never evaluated. */
export function parseProjectXml(content: string, root: 'project' | 'solution'): ProjectDeclarations | null {
  const result: ProjectDeclarations = { isWpf: false, isWinUi: false, isWinForms: false, projectReferences: [], solutionProjects: [] };
  const options = { xmlns: false, strictEntities: true };
  const parser = sax.parser(true, options);
  // An empty frame hides arbitrary nested XML such as ProjectExtensions and item metadata.
  const frames: string[] = [];
  let sawRoot = false;
  let value = '';
  parser.onopentag = tag => {
    const name = tag.name.toLowerCase();
    const parent = frames.at(-1);
    const attr = (key: string) => Object.entries((tag as sax.Tag).attributes).find(([k]) => k.toLowerCase() === key)?.[1];
    let frame = '';
    if (parent === undefined) {
      if (sawRoot || name !== root) throw new Error('Invalid project descriptor root');
      sawRoot = true;
      frame = root;
      if (root === 'project') result.sdk = attr('sdk');
    } else if (parent === 'solution' || parent === 'folder') {
      if (name === 'folder') frame = name;
      if (name === 'project') {
        const file = attr('path');
        if (file?.toLowerCase().endsWith('.csproj')) result.solutionProjects.push(file);
      }
    } else if (parent === 'project' || parent === 'when' || parent === 'otherwise') {
      if (name === 'propertygroup' || name === 'itemgroup' || name === 'choose') frame = name;
    } else if (parent === 'choose' && (name === 'when' || name === 'otherwise')) {
      frame = name;
    } else if (parent === 'itemgroup' && name === 'projectreference') {
      const file = attr('include');
      if (file) result.projectReferences.push(file);
    } else if (parent === 'propertygroup' && properties.has(name)) {
      frame = name;
      value = '';
    }
    frames.push(frame);
  };
  parser.ontext = parser.oncdata = text => { if (properties.has(frames.at(-1) ?? '')) value += text; };
  parser.onclosetag = () => {
    const name = frames.pop();
    if (!name || !properties.has(name)) return;
    const text = value.trim();
    if (!text) return;
    switch (name) {
      case 'targetframework': result.targetFramework ??= text; break;
      case 'targetframeworks': result.targetFrameworks ??= text; break;
      case 'outputtype': result.outputType ??= text; break;
      case 'usewpf': result.isWpf ||= text.toLowerCase() === 'true'; break;
      case 'usewinui': result.isWinUi ||= text.toLowerCase() === 'true'; break;
      case 'usewindowsforms': result.isWinForms ||= text.toLowerCase() === 'true'; break;
    }
  };
  parser.onerror = error => { throw error; };
  try {
    parser.write(content).close();
    return sawRoot ? result : null;
  } catch {
    return null;
  }
}
