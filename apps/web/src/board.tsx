import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'

import type {
  BoardCommand,
  BoardSnapshot,
  LaneId,
  ParticipantPresence,
  ReleaseCard,
} from '@realtime-collaboration/protocol'

import type { DemoSession, PresenceSelection } from './types.js'

const lanes: readonly { readonly id: LaneId; readonly label: string; readonly tone: string }[] = [
  { id: 'planned', label: 'Planned', tone: 'violet' },
  { id: 'in-progress', label: 'In progress', tone: 'amber' },
  { id: 'ready', label: 'Ready', tone: 'green' },
]

interface ReleaseBoardProps {
  readonly board: BoardSnapshot
  readonly participants: readonly ParticipantPresence[]
  readonly session: DemoSession
  readonly onCommand: (command: BoardCommand) => void
  readonly onPresence: (presence: PresenceSelection) => void
}

export function ReleaseBoard({
  board,
  participants,
  session,
  onCommand,
  onPresence,
}: ReleaseBoardProps) {
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const people = useMemo(() => uniqueParticipants(session, participants), [participants, session])

  function updatePresence(next: Partial<PresenceSelection>): void {
    const presence = {
      selectedCardId,
      editingCardId,
      ...next,
    }
    setSelectedCardId(presence.selectedCardId)
    setEditingCardId(presence.editingCardId)
    onPresence(presence)
  }

  function dragEnded(event: DragEndEvent): void {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null

    if (!overId || overId === activeId) {
      return
    }

    const activeCard = board.cards.find((card) => card.id === activeId)

    if (!activeCard) {
      return
    }

    const overCard = board.cards.find((card) => card.id === overId)
    const targetLane = overCard?.laneId ?? laneFromDropId(overId)

    if (!targetLane) {
      return
    }

    onCommand({
      type: 'card.move',
      cardId: activeCard.id,
      laneId: targetLane,
      beforeCardId: overCard?.id ?? null,
    })
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={dragEnded} sensors={sensors}>
      <div className="board" aria-label={`${board.title} board`}>
        {lanes.map((lane) => (
          <BoardLane
            key={lane.id}
            lane={lane}
            cards={board.cards.filter((card) => card.laneId === lane.id)}
            people={people}
            selectedCardId={selectedCardId}
            onCommand={onCommand}
            onEdit={(cardId) => updatePresence({ editingCardId: cardId, selectedCardId: cardId })}
            onSelect={(cardId) => updatePresence({ selectedCardId: cardId })}
          />
        ))}
      </div>
    </DndContext>
  )
}

interface BoardLaneProps {
  readonly lane: (typeof lanes)[number]
  readonly cards: readonly ReleaseCard[]
  readonly people: readonly ParticipantPresence[]
  readonly selectedCardId: string | null
  readonly onCommand: (command: BoardCommand) => void
  readonly onEdit: (cardId: string | null) => void
  readonly onSelect: (cardId: string) => void
}

function BoardLane({
  lane,
  cards,
  people,
  selectedCardId,
  onCommand,
  onEdit,
  onSelect,
}: BoardLaneProps) {
  const { isOver, setNodeRef } = useDroppable({ id: laneDropId(lane.id) })

  return (
    <section
      className={`board-lane ${isOver ? 'board-lane-over' : ''}`}
      ref={setNodeRef}
      aria-labelledby={`lane-${lane.id}`}
    >
      <header className="lane-header">
        <div>
          <span className={`lane-dot lane-dot-${lane.tone}`} aria-hidden="true" />
          <h2 id={`lane-${lane.id}`}>{lane.label}</h2>
        </div>
        <span className="lane-count" aria-label={`${cards.length} cards`}>
          {cards.length}
        </span>
      </header>
      <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <div className="card-list">
          {cards.map((card) => (
            <ReleaseCardView
              key={card.id}
              card={card}
              people={people}
              selected={selectedCardId === card.id}
              onCommand={onCommand}
              onEdit={onEdit}
              onSelect={onSelect}
            />
          ))}
          {cards.length === 0 ? <p className="empty-lane">Drop a card here</p> : null}
        </div>
      </SortableContext>
    </section>
  )
}

interface ReleaseCardViewProps {
  readonly card: ReleaseCard
  readonly people: readonly ParticipantPresence[]
  readonly selected: boolean
  readonly onCommand: (command: BoardCommand) => void
  readonly onEdit: (cardId: string | null) => void
  readonly onSelect: (cardId: string) => void
}

function ReleaseCardView({
  card,
  people,
  selected,
  onCommand,
  onEdit,
  onSelect,
}: ReleaseCardViewProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(card.title)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const laneIndex = lanes.findIndex((lane) => lane.id === card.laneId)

  function submitRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = title.trim()

    if (normalized && normalized !== card.title) {
      onCommand({ type: 'card.rename', cardId: card.id, title: normalized })
    }

    setEditing(false)
    onEdit(null)
  }

  function beginEditing(): void {
    setTitle(card.title)
    setEditing(true)
    onEdit(card.id)
  }

  return (
    <article
      className={`release-card ${selected ? 'release-card-selected' : ''} ${isDragging ? 'release-card-dragging' : ''}`}
      ref={setNodeRef}
      style={style}
      onClick={() => onSelect(card.id)}
    >
      <div className="card-topline">
        <span className={`readiness ${card.ready ? 'readiness-ready' : ''}`}>
          {card.ready ? 'Ready' : 'Reviewing'}
        </span>
        <button
          className="drag-handle"
          type="button"
          aria-label={`Move ${card.title}`}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </div>

      {editing ? (
        <form className="rename-form" onSubmit={submitRename}>
          <label className="sr-only" htmlFor={`rename-${card.id}`}>
            Card title
          </label>
          <input
            id={`rename-${card.id}`}
            autoFocus
            maxLength={120}
            onBlur={() => {
              setEditing(false)
              onEdit(null)
            }}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        </form>
      ) : (
        <button className="card-title" type="button" onDoubleClick={beginEditing}>
          {card.title}
        </button>
      )}

      <label className="assignee-field">
        <span>Owner</span>
        <select
          aria-label={`Owner for ${card.title}`}
          onChange={(event) =>
            onCommand({
              type: 'card.assign',
              cardId: card.id,
              assigneeId: event.target.value || null,
            })
          }
          value={card.assigneeId ?? ''}
        >
          <option value="">Unassigned</option>
          {people.map((participant) => (
            <option key={participant.actorId} value={participant.actorId}>
              {participant.displayName}
            </option>
          ))}
        </select>
      </label>

      <footer className="card-actions">
        <div className="move-actions" aria-label={`Keyboard move actions for ${card.title}`}>
          <button
            type="button"
            aria-label={`Move ${card.title} left`}
            disabled={laneIndex === 0}
            onClick={() => moveToAdjacentLane(card, laneIndex - 1, onCommand)}
          >
            ←
          </button>
          <button
            type="button"
            aria-label={`Move ${card.title} right`}
            disabled={laneIndex === lanes.length - 1}
            onClick={() => moveToAdjacentLane(card, laneIndex + 1, onCommand)}
          >
            →
          </button>
        </div>
        <button
          className="text-action"
          type="button"
          onClick={() => onCommand({ type: 'card.set-ready', cardId: card.id, ready: !card.ready })}
        >
          {card.ready ? 'Reopen' : 'Mark ready'}
        </button>
        <button className="text-action" type="button" onClick={beginEditing}>
          Rename
        </button>
      </footer>
    </article>
  )
}

export function NewCardForm({
  onCommand,
}: {
  readonly onCommand: (command: BoardCommand) => void
}) {
  const [title, setTitle] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = title.trim()

    if (!normalized) {
      return
    }

    onCommand({
      type: 'card.create',
      cardId: globalThis.crypto.randomUUID(),
      title: normalized,
      laneId: 'planned',
      beforeCardId: null,
    })
    setTitle('')
  }

  return (
    <form className="new-card-form" onSubmit={submit}>
      <label className="sr-only" htmlFor="new-card-title">
        New card title
      </label>
      <input
        id="new-card-title"
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add release task"
        value={title}
      />
      <button className="primary-button" disabled={!title.trim()} type="submit">
        Add card
      </button>
    </form>
  )
}

function uniqueParticipants(
  session: DemoSession,
  participants: readonly ParticipantPresence[],
): ParticipantPresence[] {
  const people = new Map(participants.map((participant) => [participant.actorId, participant]))

  if (!people.has(session.actorId)) {
    people.set(session.actorId, {
      actorId: session.actorId,
      displayName: session.displayName,
      selectedCardId: null,
      editingCardId: null,
      observedAt: new Date().toISOString(),
    })
  }

  return [...people.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  )
}

function moveToAdjacentLane(
  card: ReleaseCard,
  laneIndex: number,
  onCommand: (command: BoardCommand) => void,
): void {
  const lane = lanes[laneIndex]

  if (lane) {
    onCommand({
      type: 'card.move',
      cardId: card.id,
      laneId: lane.id,
      beforeCardId: null,
    })
  }
}

function laneDropId(laneId: LaneId): string {
  return `lane:${laneId}`
}

function laneFromDropId(value: string): LaneId | null {
  const laneId = value.startsWith('lane:') ? value.slice(5) : ''
  return lanes.find((lane) => lane.id === laneId)?.id ?? null
}
