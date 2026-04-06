'use client';

import { Card } from './Card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './RadixTooltip';
import { cn } from '../lib/cn';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import {
  Children,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DotsSixVerticalIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from './Button';

export type { DropResult } from '@hello-pangea/dnd';

export type Status = {
  id: string;
  name: string;
  color: string;
};

export type Feature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: Status;
};

const getKanbanCardStyle = (
  style: CSSProperties | undefined,
  snapshot: DraggableStateSnapshot
): CSSProperties | undefined => {
  if (!style) {
    return style;
  }

  const baseTransform = style?.transform;
  const isActivelyDragging = snapshot.isDragging && !snapshot.isDropAnimating;

  return {
    ...style,
    transform: isActivelyDragging
      ? baseTransform
        ? `${baseTransform} rotate(-1.1deg) scale(1.016) translateZ(0)`
        : 'rotate(-1.1deg) scale(1.016) translateZ(0)'
      : baseTransform
        ? `${baseTransform} translateZ(0)`
        : undefined,
    transition: snapshot.isDropAnimating
      ? 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease-out'
      : style.transition,
    zIndex: isActivelyDragging ? 40 : style.zIndex,
  };
};

// =============================================================================
// Kanban Board (Droppable Column)
// =============================================================================

export type KanbanBoardProps = {
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ children, className }: KanbanBoardProps) => {
  return (
    <div
      className={cn(
        'kanban-board-column flex min-h-[24rem] flex-col',
        className
      )}
    >
      {children}
    </div>
  );
};

// =============================================================================
// Kanban Card (Draggable)
// =============================================================================

export type KanbanCardProps = Pick<Feature, 'id' | 'name'> & {
  index: number;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
  tabIndex?: number;
  forwardedRef?: Ref<HTMLDivElement>;
  onKeyDown?: (e: KeyboardEvent) => void;
  isOpen?: boolean;
  dragDisabled?: boolean;
  isMobile?: boolean;
};

export const KanbanCard = ({
  id,
  name,
  index,
  children,
  className,
  onClick,
  tabIndex,
  forwardedRef,
  onKeyDown,
  isOpen,
  dragDisabled = false,
  isMobile,
}: KanbanCardProps) => {
  return (
    <Draggable draggableId={id} index={index} isDragDisabled={dragDisabled}>
      {(provided: DraggableProvided, snapshot: DraggableStateSnapshot) => {
        // Combine DnD ref and forwarded ref
        const setRefs = (node: HTMLDivElement | null) => {
          provided.innerRef(node);
          if (typeof forwardedRef === 'function') {
            forwardedRef(node);
          } else if (forwardedRef && typeof forwardedRef === 'object') {
            (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
              node;
          }
        };

        return (
          <Card
            className={cn(
              'kanban-card-premium-hover mx-2 mb-3 flex flex-col overflow-hidden rounded-[22px] border border-border/60 bg-background/90 text-foreground shadow-sm outline-none transition-[box-shadow,border-color,background-color,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
              snapshot.isDragging &&
                'cursor-grabbing border-brand/40 shadow-2xl scale-[1.02] z-50',
              isOpen && 'border-brand/40 ring-1 ring-brand/30 scale-[1.012] shadow-md z-10',
              'focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:scale-[1.01]',
              className
            )}
            ref={setRefs}
            {...provided.draggableProps}
            data-dragging={snapshot.isDragging ? 'true' : undefined}
            data-drop-animating={snapshot.isDropAnimating ? 'true' : undefined}
            data-open={isOpen ? 'true' : undefined}
            style={getKanbanCardStyle(
              provided.draggableProps.style as CSSProperties | undefined,
              snapshot
            )}
            {...(isMobile ? {} : provided.dragHandleProps)}
            tabIndex={tabIndex}
            onClick={
              isMobile
                ? () => {
                    if (!snapshot.isDragging) onClick?.();
                  }
                : undefined
            }
            onMouseUp={
              !isMobile
                ? (e) => {
                    if (e.button === 0 && !snapshot.isDragging) {
                      onClick?.();
                    }
                  }
                : undefined
            }
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const y = e.clientY - rect.top;
              e.currentTarget.style.setProperty('--mouse-x', `${x}px`);
              e.currentTarget.style.setProperty('--mouse-y', `${y}px`);
            }}
            onKeyDown={onKeyDown}
          >
            <div className="kanban-card-surface">
              {isMobile ? (
                <div className="flex gap-half">
                  <div
                    {...provided.dragHandleProps}
                    className="flex items-start pt-half cursor-grab shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DotsSixVerticalIcon
                      className="size-icon-xs text-low"
                      weight="bold"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    {children ?? (
                      <p className="m-0 font-medium text-sm">{name}</p>
                    )}
                  </div>
                </div>
              ) : (
                (children ?? <p className="m-0 font-medium text-sm">{name}</p>)
              )}
            </div>
          </Card>
        );
      }}
    </Draggable>
  );
};

// =============================================================================
// Kanban Cards Container
// =============================================================================

export type KanbanCardsProps = {
  id: string;
  children: ReactNode;
  className?: string;
  isEmpty?: boolean;
  emptyState?: ReactNode;
};

export const KanbanCards = ({
  id,
  children,
  className,
  isEmpty,
  emptyState,
}: KanbanCardsProps) => {
  const hasChildren = Children.toArray(children).length > 0;
  const shouldShowEmptyState = isEmpty ?? !hasChildren;

  return (
    <Droppable droppableId={id}>
      {(provided: DroppableProvided, snapshot: DroppableStateSnapshot) => (
        <div
          className={cn('kanban-dropzone flex flex-1 flex-col', className)}
          ref={provided.innerRef}
          data-dragging-over={snapshot.isDraggingOver ? 'true' : undefined}
          data-empty={shouldShowEmptyState ? 'true' : undefined}
          {...provided.droppableProps}
        >
          {children}
          {shouldShowEmptyState ? (
            <div
              className="kanban-empty-state"
              aria-hidden={emptyState ? undefined : true}
            >
              <div className="kanban-empty-state__ambient" />
              <div className="kanban-empty-state__figure" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {emptyState ? (
                <div className="kanban-empty-state__content">{emptyState}</div>
              ) : null}
            </div>
          ) : null}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
};

// =============================================================================
// Kanban Header
// =============================================================================

export type KanbanHeaderProps =
  | {
      children: ReactNode;
      className?: string;
    }
  | {
      name: Status['name'];
      color: Status['color'];
      className?: string;
      onAddTask?: () => void;
    };

export const KanbanHeader = (props: KanbanHeaderProps) => {
  const { t } = useTranslation('tasks');

  if ('children' in props) {
    return (
      <Card className={cn('kanban-column-header', props.className)}>
        {props.children}
      </Card>
    );
  }

  return (
    <Card
      className={cn('kanban-column-header', props.className)}
      style={{
        backgroundImage: `linear-gradient(hsl(var(${props.color}) / 0.03), hsl(var(${props.color}) / 0.03))`,
      }}
    >
      <span className="flex-1 flex items-center gap-base">
        <div
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: `hsl(var(${props.color}))` }}
        />

        <p className="m-0 text-sm">{props.name}</p>
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className="kanban-column-icon-button !h-8 !w-8 !p-0 !text-foreground/70 hover:!text-foreground"
              onClick={props.onAddTask}
              aria-label={t('actions.addTask')}
            >
              <PlusIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('actions.addTask')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Card>
  );
};

// =============================================================================
// Kanban Provider (DragDropContext)
// =============================================================================

export type KanbanProviderProps = {
  children: ReactNode;
  onDragEnd: (result: DropResult) => void;
  className?: string;
};

export const KanbanProvider = ({
  children,
  onDragEnd,
  className,
}: KanbanProviderProps) => {
  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div
        className={cn(
          'kanban-provider inline-grid min-h-full grid-flow-col auto-cols-[minmax(280px,380px)] items-stretch gap-3 pb-3',
          className
        )}
      >
        {children}
      </div>
    </DragDropContext>
  );
};
