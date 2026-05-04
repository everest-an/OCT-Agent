import { describe, expect, it } from 'vitest';
import {
  getFileExtension,
  isLikelyUnreadableBinaryText,
  resolveDocAbsolutePath,
  shouldPreferNativeDocViewer,
  shouldRenderMarkdown,
} from '../components/memory/workspace-doc-utils';

describe('workspace-doc-utils', () => {
  it('extracts lowercase extension from file path', () => {
    expect(getFileExtension('docs/Plan.DOCX')).toBe('.docx');
    expect(getFileExtension('README.md')).toBe('.md');
    expect(getFileExtension('noext')).toBe('');
  });

  it('detects markdown renderable extensions', () => {
    expect(shouldRenderMarkdown('.md')).toBe(true);
    expect(shouldRenderMarkdown('.mdx')).toBe(true);
    expect(shouldRenderMarkdown('.docx')).toBe(false);
  });

  it('prefers native viewer for binary-looking office text', () => {
    const garbled = 'PK\u0003\u0004\u0000\u0000\u0000\u0000word/document.xml\u0000\u0000\u0000';
    expect(isLikelyUnreadableBinaryText(garbled)).toBe(true);
    expect(shouldPreferNativeDocViewer('.docx', garbled)).toBe(true);
    expect(shouldPreferNativeDocViewer('.md', garbled)).toBe(false);
  });

  it('resolves absolute path from metadata first', () => {
    const detail: any = {
      title: 'Report.docx',
      metadata: {
        absolutePath: 'C:\\Users\\admin\\Docs\\Report.docx',
        relativePath: 'Docs/Report.docx',
      },
    };
    expect(resolveDocAbsolutePath(detail, 'Report.docx', 'E:\\Workspace')).toBe('C:\\Users\\admin\\Docs\\Report.docx');
  });

  it('builds absolute path from workspace root and relative path', () => {
    const detail: any = {
      title: 'Spec.docx',
      metadata: {
        relativePath: 'docs/specs/Spec.docx',
      },
    };
    expect(resolveDocAbsolutePath(detail, 'Spec.docx', 'E:\\AwarenessClaw')).toBe('E:\\AwarenessClaw\\docs\\specs\\Spec.docx');
  });
});
