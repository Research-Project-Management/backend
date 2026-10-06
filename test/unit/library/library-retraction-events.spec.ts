import { RetractionItemEventsSubscriber } from '@/modules/library/ingestion/core/adapters/retraction-item-events.subscriber';

describe('RetractionItemEventsSubscriber', () => {
  const makeSubscriber = () => {
    const retraction = { checkItem: jest.fn().mockResolvedValue({}) };
    const subscriber = new RetractionItemEventsSubscriber(retraction as any);
    return { retraction, subscriber };
  };

  const event = (updatedFields?: string[]) => ({
    aggregateId: 'item-1',
    userId: 'user-1',
    projectId: null,
    payload: updatedFields ? { updatedFields } : {},
  });

  it('re-checks when the DOI was edited', async () => {
    const { retraction, subscriber } = makeSubscriber();
    await subscriber.handleItemUpdated(event(['doi']));
    expect(retraction.checkItem).toHaveBeenCalledWith(
      'user-1',
      'item-1',
      undefined,
    );
  });

  it('re-checks when generic fields (which can hold the PMID) were edited', async () => {
    const { retraction, subscriber } = makeSubscriber();
    await subscriber.handleItemUpdated(event(['fields']));
    expect(retraction.checkItem).toHaveBeenCalledTimes(1);
  });

  it('ignores edits that cannot change an identifier', async () => {
    const { retraction, subscriber } = makeSubscriber();
    await subscriber.handleItemUpdated(event(['title', 'abstract']));
    expect(retraction.checkItem).not.toHaveBeenCalled();
  });

  it('never throws when the re-check fails', async () => {
    const { retraction, subscriber } = makeSubscriber();
    retraction.checkItem.mockRejectedValue(new Error('boom'));
    await expect(
      subscriber.handleItemUpdated(event(['doi'])),
    ).resolves.toBeUndefined();
  });
});
