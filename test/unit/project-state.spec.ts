import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { StateService } from '@/modules/project/state/state.service';
import { StateRepository } from '@/modules/project/state/state.repository';

// ── Mock Repository ──────────────────────────────────────────────────────────

const mockStateRepo: Record<string, any> = {
  findProjectState: jest.fn(),
  findProjectStates: jest.fn(),
  findProjectStateById: jest.fn(),
  createProjectState: jest.fn(),
  updateProjectStateItem: jest.fn(),
  reorderProjectStates: jest.fn(),
  deleteProjectState: jest.fn(),
  seedDefaultProjectStates: jest.fn(),
  setCurrentProjectState: jest.fn(),
};

describe('StateService (Dynamic Project State)', () => {
  let service: StateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StateService,
        { provide: StateRepository, useValue: mockStateRepo },
      ],
    }).compile();

    service = module.get<StateService>(StateService);
  });

  // ── 1. Default Template ──────────────────────────────────────────────────────

  describe('getDefaultStatesTemplate', () => {
    it('should return exactly 8 default research project state templates', () => {
      const template = service.getDefaultStatesTemplate();
      expect(template).toHaveLength(8);
    });

    it('should include all expected default research states in order', () => {
      const template = service.getDefaultStatesTemplate();
      const stateNames = template.map((s) => s.name);
      expect(stateNames).toEqual([
        'Thuyết minh đề cương',
        'Thẩm định & Phê duyệt',
        'Triển khai & Thực nghiệm',
        'Soạn thảo & Công bố',
        'Nghiệm thu & Đánh giá',
        'Hoàn thành & Lưu trữ',
        'Tạm dừng',
        'Hủy bỏ',
      ]);
    });

    it('should have first state marked as isDefault: true', () => {
      const template = service.getDefaultStatesTemplate();
      expect(template[0].isDefault).toBe(true);
      expect(template.slice(1).every((s) => !s.isDefault)).toBe(true);
    });

    it('should have non-empty colors, descriptions, and sequence 0-7', () => {
      const template = service.getDefaultStatesTemplate();
      template.forEach((s, idx) => {
        expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(s.description.length).toBeGreaterThan(10);
        expect(s.sequence).toBe(idx);
      });
    });
  });

  // ── 2. Current State Retrieval ───────────────────────────────────────────────

  describe('getProjectCurrentState', () => {
    const projectId = '00000000-0000-0000-0000-000000000001';

    it('should return current state details when state is set', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        stateId: 'state-1',
        state: {
          id: 'state-1',
          name: 'Thuyết minh đề cương',
          color: '#0284c7',
          sequence: 0,
        },
      });

      const result = await service.getProjectCurrentState(projectId);
      expect(result.projectId).toBe(projectId);
      expect(result.stateId).toBe('state-1');
      expect(result.state?.name).toBe('Thuyết minh đề cương');
      expect(result.stateLabel).toBe('Thuyết minh đề cương');
    });

    it('should throw NotFoundException for non-existent project', async () => {
      mockStateRepo.findProjectState.mockResolvedValue(null);
      await expect(
        service.getProjectCurrentState('non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle null state gracefully when user has deleted all states or unassigned state', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: projectId,
        name: 'Unassigned Project',
        stateId: null,
        state: null,
      });

      const result = await service.getProjectCurrentState(projectId);
      expect(result.projectId).toBe(projectId);
      expect(result.stateId).toBeNull();
      expect(result.state).toBeNull();
      expect(result.stateLabel).toContain('Chưa đặt trạng thái');
    });
  });

  // ── 3. State Transition ─────────────────────────────────────────────────────

  describe('transitionToState', () => {
    const projectId = '00000000-0000-0000-0000-000000000001';

    it('should transition project to target stateId', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        stateId: 'state-1',
        state: { id: 'state-1', name: 'Proposal' },
      });
      mockStateRepo.findProjectStateById.mockResolvedValue({
        id: 'state-2',
        name: 'Triển khai & Thực nghiệm',
        color: '#f59e0b',
      });
      mockStateRepo.setCurrentProjectState.mockResolvedValue({
        id: projectId,
        stateId: 'state-2',
      });

      const result = await service.transitionToState(projectId, 'state-2');
      expect(result.stateId).toBe('state-2');
      expect(result.stateLabel).toBe('Triển khai & Thực nghiệm');
      expect(mockStateRepo.setCurrentProjectState).toHaveBeenCalledWith(
        projectId,
        'state-2',
      );
    });

    it('should allow unassigning state when targetStateId is null', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        stateId: 'state-1',
      });

      const result = await service.transitionToState(projectId, null);
      expect(result.stateId).toBeNull();
      expect(result.state).toBeNull();
      expect(result.stateLabel).toContain('Chưa đặt trạng thái');
      expect(mockStateRepo.setCurrentProjectState).toHaveBeenCalledWith(
        projectId,
        null,
      );
    });

    it('should throw NotFoundException if target state does not exist', async () => {
      mockStateRepo.findProjectState.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
      });
      mockStateRepo.findProjectStateById.mockResolvedValue(null);

      await expect(
        service.transitionToState(projectId, 'invalid-state-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── 4. Project States CRUD & Drag-and-Drop ───────────────────────────────────

  describe('Dynamic Project States CRUD', () => {
    const projectId = '00000000-0000-0000-0000-000000000001';

    describe('getProjectStates', () => {
      it('should return empty list if user deleted all states', async () => {
        mockStateRepo.findProjectStates.mockResolvedValue([]);
        const states = await service.getProjectStates(projectId);
        expect(states).toEqual([]);
      });

      it('should return project states ordered by sequence', async () => {
        const mockStates = [
          { id: 's1', name: 'Đề cương', sequence: 0 },
          { id: 's2', name: 'Thực nghiệm', sequence: 1 },
        ];
        mockStateRepo.findProjectStates.mockResolvedValue(mockStates);
        const states = await service.getProjectStates(projectId);
        expect(states).toHaveLength(2);
        expect(states[0].name).toBe('Đề cương');
      });
    });

    describe('createCustomState', () => {
      it('should create a custom state', async () => {
        const dto = {
          name: 'Khảo sát thực địa',
          color: '#0284c7',
          description: 'Thu thập mẫu đất',
        };
        mockStateRepo.createProjectState.mockResolvedValue({
          id: 's-new',
          ...dto,
          sequence: 2,
        });

        const created = await service.createCustomState(projectId, dto);
        expect(created.id).toBe('s-new');
        expect(created.name).toBe('Khảo sát thực địa');
      });
    });

    describe('updateCustomState', () => {
      it('should update state attributes', async () => {
        mockStateRepo.findProjectStateById.mockResolvedValue({
          id: 's1',
          name: 'Old Name',
        });
        mockStateRepo.updateProjectStateItem.mockResolvedValue({
          id: 's1',
          name: 'New Name',
        });

        const updated = await service.updateCustomState(projectId, 's1', {
          name: 'New Name',
        });
        expect(updated.name).toBe('New Name');
      });
    });

    describe('reorderStates (Drag & Drop)', () => {
      it('should reorder states by sequence', async () => {
        const reorderPayload = {
          states: [
            { id: 's2', sequence: 0 },
            { id: 's1', sequence: 1 },
          ],
        };
        mockStateRepo.reorderProjectStates.mockResolvedValue([
          { id: 's2', name: 'Thực nghiệm', sequence: 0 },
          { id: 's1', name: 'Đề cương', sequence: 1 },
        ]);

        const result = await service.reorderStates(projectId, reorderPayload);
        expect(result[0].id).toBe('s2');
        expect(mockStateRepo.reorderProjectStates).toHaveBeenCalledWith(
          projectId,
          reorderPayload.states,
        );
      });
    });

    describe('deleteCustomState (Hard delete without minimum constraint)', () => {
      it('should permanently delete state and return success', async () => {
        mockStateRepo.findProjectStateById.mockResolvedValue({
          id: 's1',
          name: 'Đề cương',
          projectId,
        });
        mockStateRepo.deleteProjectState.mockResolvedValue(undefined);

        const result = await service.deleteCustomState(projectId, 's1');
        expect(result.success).toBe(true);
        expect(mockStateRepo.deleteProjectState).toHaveBeenCalledWith(
          projectId,
          's1',
          undefined,
        );
      });
    });
  });
});
