import {
  Injectable,
  Logger,
  Optional,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  IProjectInstantiatorPort,
  InstantiateProjectInput,
  InstantiatedProjectResult,
} from '@/modules/manuscripts/templates/core/ports/project-instantiator.port';
import { PrismaService } from '@/core';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';

@Injectable()
export class ManuscriptInstantiatorAdapter implements IProjectInstantiatorPort {
  private readonly logger = new Logger(ManuscriptInstantiatorAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly structureService?: StructureService,
    @Optional()
    private readonly docstoreService?: DocstoreService,
  ) {}

  async instantiate(
    input: InstantiateProjectInput,
  ): Promise<InstantiatedProjectResult> {
    const { template, projectName, userId } = input;
    const generatedProjectId = crypto.randomUUID();
    const cleanName = projectName.trim() || template.name;
    const baseSlug =
      cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'manuscript';
    const identifier = `${baseSlug}-${generatedProjectId.slice(0, 6)}`;

    const fileEntries = Object.entries(template.files);
    const filePaths = Object.keys(template.files);

    let finalProjectId: string = generatedProjectId;

    try {
      // 1. If Prisma is connected, create project record & assign ownership
      const project = await this.prisma.project.create({
        data: {
          id: generatedProjectId,
          name: cleanName,
          identifier,
          description: `Created from template: ${template.name}`,
          createdById: userId,
          modules: [
            'overview',
            'work_items',
            'cycles',
            'views',
            'pages',
            'manuscript',
          ],
          settings: {
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
        await this.prisma.projectMember
          .create({
            data: {
              projectId: finalProjectId,
              userId,
              role: 'owner',
            },
          })
          .catch(() => {});
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Prisma project creation failed: ${msg}`);
      throw new InternalServerErrorException(
        `Failed to create project from template: ${msg}`,
      );
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
            const dirNode = await this.structureService.mkdirp(
              finalProjectId,
              dirPath,
            );
            parentFolderId = dirNode.id;
          }

          const isRootDoc =
            filePath === template.mainFile ||
            `/${filePath.replace(/^\//, '')}` ===
              `/${template.mainFile.replace(/^\//, '')}`;

          // Create doc in Docstore first so docId exists in manuscript_docs
          const createdDoc = await this.docstoreService.createDoc(
            finalProjectId,
            {
              path: filePath.startsWith('/') ? filePath : `/${filePath}`,
              lines: content.split('\n'),
              version: 1,
            },
          );

          // Create structure node linked to the created docId
          await this.structureService.createNode(finalProjectId, {
            name: fileName,
            type: 'DOC',
            parentId: parentFolderId,
            docId: createdDoc._id,
            isRootDoc,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Could not write node/doc for ${filePath}: ${msg}`);
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
