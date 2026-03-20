import type { RefObject } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { cn } from '../lib/cn';
import { useTranslation } from 'react-i18next';
import { PlusIcon, CheckIcon, TrashIcon } from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSearchInput,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './Dropdown';
import { InlineColorPicker, PRESET_COLORS } from './ColorPicker';

// Re-export for backwards compatibility
export const TAG_COLORS = PRESET_COLORS;

function parseHslColor(color: string): {
  hue: string;
  saturation: string;
  lightness: string;
} {
  const parts = color.trim().split(/\s+/);
  if (parts.length !== 3) {
    return { hue: '', saturation: '', lightness: '' };
  }

  return {
    hue: parts[0] ?? '',
    saturation: parts[1]?.replace('%', '') ?? '',
    lightness: parts[2]?.replace('%', '') ?? '',
  };
}

function clampColorPart(value: string, min: number, max: number): string {
  if (value.trim() === '') {
    return '';
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '';
  }

  return String(Math.min(max, Math.max(min, Math.round(parsed))));
}

export interface SearchableTag {
  id: string;
  name: string;
  color: string;
}

interface SearchableTagDropdownProps {
  filteredTags: SearchableTag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onDeleteTag?: (tagId: string) => void;
  trigger: React.ReactNode;

  // Search state
  searchTerm: string;
  onSearchTermChange: (value: string) => void;

  // Highlight state
  highlightedIndex: number | null;
  onHighlightedIndexChange: (index: number | null) => void;

  // Open state
  open: boolean;
  onOpenChange: (open: boolean) => void;

  // Keyboard handler
  onKeyDown: (e: React.KeyboardEvent) => void;

  // Virtuoso ref
  virtuosoRef: RefObject<VirtuosoHandle | null>;

  // Create flow
  showCreateOption: boolean;
  createOptionHighlighted: boolean;
  isCreating: boolean;
  newTagColor: string;
  onNewTagColorChange: (color: string) => void;
  onStartCreate: () => void;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;

  // Ref for color picker container (for focus management)
  colorPickerRef: RefObject<HTMLDivElement>;

  contentClassName?: string;
  disabled?: boolean;
}

export function SearchableTagDropdown({
  filteredTags,
  selectedTagIds,
  onTagToggle,
  onDeleteTag,
  trigger,
  searchTerm,
  onSearchTermChange,
  highlightedIndex,
  onHighlightedIndexChange,
  open,
  onOpenChange,
  onKeyDown,
  virtuosoRef,
  showCreateOption,
  createOptionHighlighted,
  isCreating,
  newTagColor,
  onNewTagColorChange,
  onStartCreate,
  onConfirmCreate,
  onCancelCreate,
  colorPickerRef,
  contentClassName,
  disabled,
}: SearchableTagDropdownProps) {
  const { t } = useTranslation('common');
  const { hue, saturation, lightness } = parseHslColor(newTagColor);

  const updateColorPart = (
    part: 'hue' | 'saturation' | 'lightness',
    value: string
  ) => {
    const nextHue =
      part === 'hue' ? clampColorPart(value, 0, 360) : hue;
    const nextSaturation =
      part === 'saturation' ? clampColorPart(value, 0, 100) : saturation;
    const nextLightness =
      part === 'lightness' ? clampColorPart(value, 0, 100) : lightness;

    onNewTagColorChange(
      `${nextHue || '0'} ${nextSaturation || '0'}% ${nextLightness || '0'}%`
    );
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn('min-w-[220px]', contentClassName)}
      >
        {isCreating ? (
          // Color picker step
          <div
            ref={colorPickerRef}
            className="p-base space-y-base outline-none"
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <div className="text-sm text-normal">
              {t('kanban.selectColorFor')}{' '}
              <span className="font-medium">{searchTerm}</span>
            </div>
            <InlineColorPicker
              value={newTagColor}
              onChange={onNewTagColorChange}
              colors={TAG_COLORS}
            />
            <div className="grid grid-cols-3 gap-half">
              <label className="flex flex-col gap-1 text-xs text-low">
                <span>H</span>
                <input
                  type="number"
                  min={0}
                  max={360}
                  value={hue}
                  onChange={(e) => updateColorPart('hue', e.target.value)}
                  className="rounded-sm border border-border bg-panel px-2 py-1 text-sm text-normal outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-low">
                <span>S%</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={saturation}
                  onChange={(e) =>
                    updateColorPart('saturation', e.target.value)
                  }
                  className="rounded-sm border border-border bg-panel px-2 py-1 text-sm text-normal outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-low">
                <span>L%</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={lightness}
                  onChange={(e) =>
                    updateColorPart('lightness', e.target.value)
                  }
                  className="rounded-sm border border-border bg-panel px-2 py-1 text-sm text-normal outline-none focus:border-brand"
                />
              </label>
            </div>
            <div className="flex items-center gap-2 rounded-sm border border-border/70 bg-panel px-2 py-1.5 text-xs text-low">
              <span
                className="h-3 w-3 shrink-0 rounded-full border border-border/60"
                style={{ backgroundColor: `hsl(${newTagColor})` }}
              />
              <span className="font-mono text-[11px] text-normal">
                {newTagColor}
              </span>
            </div>
            <div className="flex items-center justify-end gap-half pt-half">
              <button
                type="button"
                onClick={onCancelCreate}
                className="px-base py-half text-sm text-low hover:text-normal hover:bg-panel rounded-sm transition-colors"
              >
                {t('buttons.cancel')}
              </button>
              <button
                type="button"
                onClick={onConfirmCreate}
                className="px-base py-half text-sm text-high bg-brand hover:bg-brand/90 rounded-sm transition-colors"
              >
                {t('buttons.create')}
              </button>
            </div>
          </div>
        ) : (
          // Search and tag list
          <>
            <DropdownMenuSearchInput
              placeholder={t('kanban.searchTags')}
              value={searchTerm}
              onValueChange={onSearchTermChange}
              onKeyDown={onKeyDown}
            />
            <DropdownMenuSeparator />
            {filteredTags.length === 0 && !showCreateOption ? (
              <div className="px-base py-half text-sm text-low text-center">
                {t('kanban.noTagsAvailable')}
              </div>
            ) : (
              <>
                {filteredTags.length > 0 && (
                  <Virtuoso
                    ref={virtuosoRef as React.RefObject<VirtuosoHandle>}
                    style={{ height: Math.min(filteredTags.length * 36, 200) }}
                    totalCount={filteredTags.length}
                    computeItemKey={(idx) =>
                      filteredTags[idx]?.id ?? String(idx)
                    }
                    itemContent={(idx) => {
                      const tag = filteredTags[idx];
                      const isSelected = selectedTagIds.includes(tag.id);
                      const isHighlighted = idx === highlightedIndex;
                      return (
                        <div
                          onMouseEnter={() => onHighlightedIndexChange(idx)}
                          className={cn(
                            'group flex items-center gap-1 px-base py-half text-sm transition-colors',
                            isHighlighted && 'bg-secondary',
                            isSelected && 'text-normal'
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => onTagToggle(tag.id)}
                            className="flex min-w-0 flex-1 items-center gap-base text-left"
                          >
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: `hsl(${tag.color})` }}
                            />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {isSelected && (
                              <CheckIcon
                                className="size-icon-sm text-brand shrink-0"
                                weight="bold"
                              />
                            )}
                          </button>
                          {onDeleteTag && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteTag(tag.id);
                              }}
                              className={cn(
                                'ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-low transition-colors',
                                'hover:bg-error/10 hover:text-error',
                                isHighlighted
                                  ? 'opacity-100'
                                  : 'opacity-0 group-hover:opacity-100'
                              )}
                              aria-label={`Delete tag ${tag.name}`}
                              title={`Delete tag ${tag.name}`}
                            >
                              <TrashIcon className="size-icon-xs" weight="bold" />
                            </button>
                          )}
                        </div>
                      );
                    }}
                  />
                )}
                {showCreateOption && (
                  <>
                    {filteredTags.length > 0 && <DropdownMenuSeparator />}
                    <button
                      type="button"
                      onClick={onStartCreate}
                      className={cn(
                        'flex items-center gap-base w-full px-base py-half text-sm text-brand hover:bg-secondary transition-colors',
                        createOptionHighlighted && 'bg-secondary'
                      )}
                    >
                      <PlusIcon className="size-icon-sm" weight="bold" />
                      <span>
                        {t('kanban.createTag')} &quot;{searchTerm}&quot;
                      </span>
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
