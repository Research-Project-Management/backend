import { Injectable, Logger, Optional, forwardRef, Inject } from '@nestjs/common';
import {
  IProjectInstantiatorPort,
  InstantiateProjectInput,
  InstantiatedProjectResult,
} from '../../ports/project-instantiator.port';
import { PrismaService } from '@/core/database/prisma.service';
import { StructureService } from '../../../../structure/structure.service';
import { DocstoreService } from '../../../../docstore/docstore.service';

@Injectable()
export class ManuscriptInstantiatorAdapter implements IProjectInstantiatorPort {
  private readonly logger = new Logger(ManuscriptInstantiatorAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(forwardRef(() => StructureService))
    private readonly structureService?: StructureService,
    @Optional()
    @Inject(forwardRef(() => DocstoreService))
    private readonly docstoreService?: DocstoreService,
  ) {}

  async instantiate(input: InstantiateProjectInput): Promise<InstantiatedProjectResult> {
    const { template, projectName, userId } = input;
    const generatedProjectId = crypto.randomUUID();
    const cleanName = projectName.trim() || template.name;
    const baseSlug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'manuscript';
    const identifier = `${baseSlug}-${generatedProjectId.slice(0, 6)}`;

    const fileEntries = Object.entries(template.files);
    const filePaths = Object.keys(template.files);

    let finalProjectId = generatedProjectId;

    try {
      // 1. If Prisma is connected, create project record & assign ownership
      const project = await (this.prisma as any).project.create({
        data: {
          id: generatedProjectId,
          name: cleanName,
          identifier,
          description: `Created from template: ${template.name}`,
          createdById: userId,
          modules: {
            manuscript: {
              compiler: template.compiler,
              mainFile: template.mainFile,
              imageName: template.imageName,
              fromTemplateId: template.id,
              fromTemplateVersionId: template.versionId,
            },
          },
        },
      });

      if (project?.id) {
        finalProjectId = project.id;
        // Add user as project owner
        await (this.prisma as any).projectMember.create({
          data: {
            projectId: finalProjectId,
            userId,
            role: 'owner',
          },
        }).catch(() => {
          // ignore if already added or in mock
        });
      }
    } catch (err: any) {
      this.logger.debug(`Prisma project creation skipped or failed (mock/fallback mode): ${err?.message}`);
    }

    // 2. If StructureService & DocstoreService are available, populate directory nodes & docs
    if (this.structureService && this.docstoreService) {
      for (const [filePath, content] of fileEntries) {
        try {
          const parts = filePath.split('/');
          const fileName = parts.pop() || filePath;
          let parentFolderId: string | undefined = undefined;

          if (parts.length > 0) {
            const dirPath = parts.join('/');
            const dirNode = await this.structureService.mkdirp(finalProjectId, dirPath);
            parentFolderId = dirNode.id;
          }

          // Create structure node
          const node = await this.structureService.createNode(finalProjectId, {
            name: fileName,
            type: 'DOC',
            parentId: parentFolderId,
          });

          // Populate doc content in Docstore
          if (node?.docId) {
            await this.docstoreService.updateDoc(finalProjectId, node.docId, {
              lines: content.split('\n'),
              version: 1,
            });
          }
        } catch (err: any) {
          this.logger.debug(`Could not write node/doc for ${filePath}: ${err?.message}`);
        }
      }
    }

    return {
      projectId: finalProjectId,
      projectName: cleanName,
      ownerId: userId,
      compiler: template.compiler,
      mainFile: template.mainFile,
      fileCount: filePaths.length,
      files: filePaths,
      fromTemplateId: template.id,
      fromTemplateVersionId: template.versionId,
      createdAt: new Date(),
    };
  }
}
