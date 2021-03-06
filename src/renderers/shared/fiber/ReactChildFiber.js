/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactChildFiber
 * @flow
 */

'use strict';

import type { ReactElement } from 'ReactElementType';
import type { ReactCoroutine, ReactYield } from 'ReactCoroutine';
import type { ReactPortal } from 'ReactPortal';
import type { Fiber } from 'ReactFiber';
import type { ReactInstance } from 'ReactInstanceType';
import type { PriorityLevel } from 'ReactPriorityLevel';

var REACT_ELEMENT_TYPE = require('ReactElementSymbol');
var {
  REACT_COROUTINE_TYPE,
  REACT_YIELD_TYPE,
} = require('ReactCoroutine');
var {
  REACT_PORTAL_TYPE,
} = require('ReactPortal');

var ReactFiber = require('ReactFiber');
var ReactReifiedYield = require('ReactReifiedYield');
var ReactTypeOfSideEffect = require('ReactTypeOfSideEffect');
var ReactTypeOfWork = require('ReactTypeOfWork');

var emptyObject = require('emptyObject');
var getIteratorFn = require('getIteratorFn');
var invariant = require('invariant');

if (__DEV__) {
  var { getCurrentFiberStackAddendum } = require('ReactDebugCurrentFiber');
  var warning = require('warning');
}

const {
  cloneFiber,
  createFiberFromElement,
  createFiberFromFragment,
  createFiberFromText,
  createFiberFromCoroutine,
  createFiberFromYield,
  createFiberFromPortal,
} = ReactFiber;

const {
  createReifiedYield,
  createUpdatedReifiedYield,
} = ReactReifiedYield;

const isArray = Array.isArray;

const {
  ClassComponent,
  HostText,
  HostPortal,
  CoroutineComponent,
  YieldComponent,
  Fragment,
} = ReactTypeOfWork;

const {
  NoEffect,
  Placement,
  Deletion,
} = ReactTypeOfSideEffect;

function coerceRef(current: ?Fiber, element: ReactElement) {
  let mixedRef = element.ref;
  if (mixedRef != null && typeof mixedRef !== 'function') {
    if (element._owner) {
      const ownerFiber : ?(Fiber | ReactInstance) = (element._owner : any);
      let inst;
      if (ownerFiber) {
        if ((ownerFiber : any).tag === ClassComponent) {
          inst = (ownerFiber : any).stateNode;
        } else {
          // Stack
          inst = (ownerFiber : any).getPublicInstance();
        }
      }
      invariant(inst, 'Missing owner for string ref %s', mixedRef);
      const stringRef = String(mixedRef);
      // Check if previous string ref matches new string ref
      if (current && current.ref && current.ref._stringRef === stringRef) {
        return current.ref;
      }
      const ref = function(value) {
        const refs = inst.refs === emptyObject ? (inst.refs = {}) : inst.refs;
        if (value === null) {
          delete refs[stringRef];
        } else {
          refs[stringRef] = value;
        }
      };
      ref._stringRef = stringRef;
      return ref;
    }
  }
  return mixedRef;
}

// This wrapper function exists because I expect to clone the code in each path
// to be able to optimize each path individually by branching early. This needs
// a compiler or we can do it manually. Helpers that don't need this branching
// live outside of this function.
function ChildReconciler(shouldClone, shouldTrackSideEffects) {

  function deleteChild(
    returnFiber : Fiber,
    childToDelete : Fiber
  ) : void {
    if (!shouldTrackSideEffects) {
      // Noop.
      return;
    }
    if (!shouldClone) {
      // When we're reconciling in place we have a work in progress copy. We
      // actually want the current copy. If there is no current copy, then we
      // don't need to track deletion side-effects.
      if (!childToDelete.alternate) {
        return;
      }
      childToDelete = childToDelete.alternate;
    }
    // Deletions are added in reversed order so we add it to the front.
    const last = returnFiber.progressedLastDeletion;
    if (last) {
      last.nextEffect = childToDelete;
      returnFiber.progressedLastDeletion = childToDelete;
    } else {
      returnFiber.progressedFirstDeletion =
        returnFiber.progressedLastDeletion =
          childToDelete;
    }
    childToDelete.nextEffect = null;
    childToDelete.effectTag = Deletion;
  }

  function deleteRemainingChildren(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber
  ) : null {
    if (!shouldTrackSideEffects) {
      // Noop.
      return null;
    }

    // TODO: For the shouldClone case, this could be micro-optimized a bit by
    // assuming that after the first child we've already added everything.
    let childToDelete = currentFirstChild;
    while (childToDelete) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
    return null;
  }

  function mapRemainingChildren(
    returnFiber : Fiber,
    currentFirstChild : Fiber
  ) : Map<string | number, Fiber> {
    // Add the remaining children to a temporary map so that we can find them by
    // keys quickly. Implicit (null) keys get added to this set with their index
    // instead.
    const existingChildren : Map<string | number, Fiber> = new Map();

    let existingChild = currentFirstChild;
    while (existingChild) {
      if (existingChild.key !== null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    return existingChildren;
  }

  function useFiber(fiber : Fiber, priority : PriorityLevel) : Fiber {
    // We currently set sibling to null and index to 0 here because it is easy
    // to forget to do before returning it. E.g. for the single child case.
    if (shouldClone) {
      const clone = cloneFiber(fiber, priority);
      clone.index = 0;
      clone.sibling = null;
      return clone;
    } else {
      // We override the pending priority even if it is higher, because if
      // we're reconciling at a lower priority that means that this was
      // down-prioritized.
      fiber.pendingWorkPriority = priority;
      fiber.effectTag = NoEffect;
      fiber.index = 0;
      fiber.sibling = null;
      return fiber;
    }
  }

  function placeChild(newFiber : Fiber, lastPlacedIndex : number, newIndex : number) : number {
    newFiber.index = newIndex;
    if (!shouldTrackSideEffects) {
      // Noop.
      return lastPlacedIndex;
    }
    const current = newFiber.alternate;
    if (current) {
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        // This is a move.
        newFiber.effectTag = Placement;
        return lastPlacedIndex;
      } else {
        // This item can stay in place.
        return oldIndex;
      }
    } else {
      // This is an insertion.
      newFiber.effectTag = Placement;
      return lastPlacedIndex;
    }
  }

  function placeSingleChild(newFiber : Fiber) : Fiber {
    // This is simpler for the single child case. We only need to do a
    // placement for inserting new children.
    if (shouldTrackSideEffects && !newFiber.alternate) {
      newFiber.effectTag = Placement;
    }
    return newFiber;
  }

  function updateTextNode(
    returnFiber : Fiber,
    current : ?Fiber,
    textContent : string,
    priority : PriorityLevel
  ) {
    if (current == null || current.tag !== HostText) {
      // Insert
      const created = createFiberFromText(textContent, priority);
      created.return = returnFiber;
      return created;
    } else {
      // Update
      const existing = useFiber(current, priority);
      existing.pendingProps = textContent;
      existing.return = returnFiber;
      return existing;
    }
  }

  function updateElement(
    returnFiber : Fiber,
    current : ?Fiber,
    element : ReactElement,
    priority : PriorityLevel
  ) : Fiber {
    if (current == null || current.type !== element.type) {
      // Insert
      const created = createFiberFromElement(element, priority);
      created.ref = coerceRef(current, element);
      created.return = returnFiber;
      return created;
    } else {
      // Move based on index
      const existing = useFiber(current, priority);
      existing.ref = coerceRef(current, element);
      existing.pendingProps = element.props;
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugSource = element._source;
        existing._debugOwner = element._owner;
      }
      return existing;
    }
  }

  function updateCoroutine(
    returnFiber : Fiber,
    current : ?Fiber,
    coroutine : ReactCoroutine,
    priority : PriorityLevel
  ) : Fiber {
    // TODO: Should this also compare handler to determine whether to reuse?
    if (current == null || current.tag !== CoroutineComponent) {
      // Insert
      const created = createFiberFromCoroutine(coroutine, priority);
      created.return = returnFiber;
      return created;
    } else {
      // Move based on index
      const existing = useFiber(current, priority);
      existing.pendingProps = coroutine;
      existing.return = returnFiber;
      return existing;
    }
  }

  function updateYield(
    returnFiber : Fiber,
    current : ?Fiber,
    yieldNode : ReactYield,
    priority : PriorityLevel
  ) : Fiber {
    // TODO: Should this also compare continuation to determine whether to reuse?
    if (current == null || current.tag !== YieldComponent) {
      // Insert
      const reifiedYield = createReifiedYield(yieldNode);
      const created = createFiberFromYield(yieldNode, priority);
      created.type = reifiedYield;
      created.return = returnFiber;
      return created;
    } else {
      // Move based on index
      const existing = useFiber(current, priority);
      existing.type = createUpdatedReifiedYield(
        current.type,
        yieldNode
      );
      existing.return = returnFiber;
      return existing;
    }
  }

  function updatePortal(
    returnFiber : Fiber,
    current : ?Fiber,
    portal : ReactPortal,
    priority : PriorityLevel
  ) : Fiber {
    if (
      current == null ||
      current.tag !== HostPortal ||
      current.stateNode.containerInfo !== portal.containerInfo ||
      current.stateNode.implementation !== portal.implementation
    ) {
      // Insert
      const created = createFiberFromPortal(portal, priority);
      created.return = returnFiber;
      return created;
    } else {
      // Update
      const existing = useFiber(current, priority);
      existing.pendingProps = portal.children || [];
      existing.return = returnFiber;
      return existing;
    }
  }

  function updateFragment(
    returnFiber : Fiber,
    current : ?Fiber,
    fragment : Iterable<*>,
    priority : PriorityLevel
  ) : Fiber {
    if (current == null || current.tag !== Fragment) {
      // Insert
      const created = createFiberFromFragment(fragment, priority);
      created.return = returnFiber;
      return created;
    } else {
      // Update
      const existing = useFiber(current, priority);
      existing.pendingProps = fragment;
      existing.return = returnFiber;
      return existing;
    }
  }

  function createChild(
    returnFiber : Fiber,
    newChild : any,
    priority : PriorityLevel
  ) : ?Fiber {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes doesn't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      const created = createFiberFromText('' + newChild, priority);
      created.return = returnFiber;
      return created;
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const created = createFiberFromElement(newChild, priority);
          created.ref = coerceRef(null, newChild);
          created.return = returnFiber;
          return created;
        }

        case REACT_COROUTINE_TYPE: {
          const created = createFiberFromCoroutine(newChild, priority);
          created.return = returnFiber;
          return created;
        }

        case REACT_YIELD_TYPE: {
          const reifiedYield = createReifiedYield(newChild);
          const created = createFiberFromYield(newChild, priority);
          created.type = reifiedYield;
          created.return = returnFiber;
          return created;
        }

        case REACT_PORTAL_TYPE: {
          const created = createFiberFromPortal(newChild, priority);
          created.return = returnFiber;
          return created;
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const created = createFiberFromFragment(newChild, priority);
        created.return = returnFiber;
        return created;
      }
    }

    return null;
  }

  function updateSlot(
    returnFiber : Fiber,
    oldFiber : ?Fiber,
    newChild : any,
    priority : PriorityLevel
  ) : ?Fiber {
    // Update the fiber if the keys match, otherwise return null.

    const key = oldFiber ? oldFiber.key : null;

    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes doesn't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      if (key !== null) {
        return null;
      }
      return updateTextNode(returnFiber, oldFiber, '' + newChild, priority);
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          if (newChild.key === key) {
            return updateElement(returnFiber, oldFiber, newChild, priority);
          } else {
            return null;
          }
        }

        case REACT_COROUTINE_TYPE: {
          if (newChild.key === key) {
            return updateCoroutine(returnFiber, oldFiber, newChild, priority);
          } else {
            return null;
          }
        }

        case REACT_YIELD_TYPE: {
          if (newChild.key === key) {
            return updateYield(returnFiber, oldFiber, newChild, priority);
          } else {
            return null;
          }
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        // Fragments doesn't have keys so if the previous key is implicit we can
        // update it.
        if (key !== null) {
          return null;
        }
        return updateFragment(returnFiber, oldFiber, newChild, priority);
      }
    }

    return null;
  }

  function updateFromMap(
    existingChildren : Map<string | number, Fiber>,
    returnFiber : Fiber,
    newIdx : number,
    newChild : any,
    priority : PriorityLevel
  ) : ?Fiber {

    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes doesn't have keys, so we neither have to check the old nor
      // new node for the key. If both are text nodes, they match.
      const matchedFiber = existingChildren.get(newIdx) || null;
      return updateTextNode(returnFiber, matchedFiber, '' + newChild, priority);
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const matchedFiber = existingChildren.get(
            newChild.key === null ? newIdx : newChild.key
          ) || null;
          return updateElement(returnFiber, matchedFiber, newChild, priority);
        }

        case REACT_COROUTINE_TYPE: {
          const matchedFiber = existingChildren.get(
            newChild.key === null ? newIdx : newChild.key
          ) || null;
          return updateCoroutine(returnFiber, matchedFiber, newChild, priority);
        }

        case REACT_YIELD_TYPE: {
          const matchedFiber = existingChildren.get(
            newChild.key === null ? newIdx : newChild.key
          ) || null;
          return updateYield(returnFiber, matchedFiber, newChild, priority);
        }

        case REACT_PORTAL_TYPE: {
          const matchedFiber = existingChildren.get(
            newChild.key === null ? newIdx : newChild.key
          ) || null;
          return updatePortal(returnFiber, matchedFiber, newChild, priority);
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const matchedFiber = existingChildren.get(newIdx) || null;
        return updateFragment(returnFiber, matchedFiber, newChild, priority);
      }
    }

    return null;
  }

  function warnOnDuplicateKey(
    child : mixed,
    knownKeys : Set<string> | null
  ) : Set<string> | null {
    if (__DEV__) {
      if (typeof child !== 'object' || child == null) {
        return knownKeys;
      }
      switch (child.$$typeof) {
        case REACT_ELEMENT_TYPE:
        case REACT_COROUTINE_TYPE:
        case REACT_YIELD_TYPE:
        case REACT_PORTAL_TYPE:
          const key = child.key;
          if (typeof key !== 'string') {
            break;
          }
          if (knownKeys == null) {
            knownKeys = new Set();
            knownKeys.add(key);
            break;
          }
          if (!knownKeys.has(key)) {
            knownKeys.add(key);
            break;
          }
          warning(
            false,
            'Encountered two children with the same key, ' +
            '`%s`. Child keys must be unique; when two children share a key, ' +
            'only the first child will be used.%s',
            key,
            getCurrentFiberStackAddendum()
          );
          break;
        default:
          break;
      }
    }
    return knownKeys;
  }

  function reconcileChildrenArray(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    newChildren : Array<*>,
    priority : PriorityLevel) : ?Fiber {

    // This algorithm can't optimize by searching from boths ends since we
    // don't have backpointers on fibers. I'm trying to see how far we can get
    // with that model. If it ends up not being worth the tradeoffs, we can
    // add it later.

    // Even with a two ended optimization, we'd want to optimize for the case
    // where there are few changes and brute force the comparison instead of
    // going for the Map. It'd like to explore hitting that path first in
    // forward-only mode and only go for the Map once we notice that we need
    // lots of look ahead. This doesn't handle reversal as well as two ended
    // search but that's unusual. Besides, for the two ended optimization to
    // work on Iterables, we'd need to copy the whole set.

    // In this first iteration, we'll just live with hitting the bad case
    // (adding everything to a Map) in for every insert/move.

    // If you change this code, also update reconcileChildrenIterator() which
    // uses the same algorithm.

    if (__DEV__) {
      // First, validate keys.
      let knownKeys = null;
      for (let i = 0; i < newChildren.length; i++) {
        const child = newChildren[i];
        knownKeys = warnOnDuplicateKey(child, knownKeys);
      }
    }

    let resultingFirstChild : ?Fiber = null;
    let previousNewFiber : ?Fiber = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;
    for (; oldFiber && newIdx < newChildren.length; newIdx++) {
      if (oldFiber) {
        if (oldFiber.index > newIdx) {
          nextOldFiber = oldFiber;
          oldFiber = null;
        } else {
          nextOldFiber = oldFiber.sibling;
        }
      }
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        newChildren[newIdx],
        priority
      );
      if (!newFiber) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (!oldFiber) {
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        if (oldFiber && !newFiber.alternate) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (!previousNewFiber) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (newIdx === newChildren.length) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      return resultingFirstChild;
    }

    if (!oldFiber) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(
          returnFiber,
          newChildren[newIdx],
          priority
        );
        if (!newFiber) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (!previousNewFiber) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(returnFiber, oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
        priority
      );
      if (newFiber) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (!previousNewFiber) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    return resultingFirstChild;
  }

  function reconcileChildrenIterator(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    newChildrenIterable : Iterable<*>,
    priority : PriorityLevel) : ?Fiber {

    // This is the same implementation as reconcileChildrenArray(),
    // but using the iterator instead.

    const iteratorFn = getIteratorFn(newChildrenIterable);
    if (typeof iteratorFn !== 'function') {
      throw new Error('An object is not an iterable.');
    }

    if (__DEV__) {
      // First, validate keys.
      // We'll get a different iterator later for the main pass.
      const newChildren = iteratorFn.call(newChildrenIterable);
      if (newChildren == null) {
        throw new Error('An iterable object provided no iterator.');
      }
      let knownKeys = null;
      let step = newChildren.next();
      for (; !step.done; step = newChildren.next()) {
        const child = step.value;
        knownKeys = warnOnDuplicateKey(child, knownKeys);
      }
    }

    const newChildren = iteratorFn.call(newChildrenIterable);
    if (newChildren == null) {
      throw new Error('An iterable object provided no iterator.');
    }

    let resultingFirstChild : ?Fiber = null;
    let previousNewFiber : ?Fiber = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;

    let step = newChildren.next();
    for (; oldFiber && !step.done; newIdx++, step = newChildren.next()) {
      if (oldFiber) {
        if (oldFiber.index > newIdx) {
          nextOldFiber = oldFiber;
          oldFiber = null;
        } else {
          nextOldFiber = oldFiber.sibling;
        }
      }
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        step.value,
        priority
      );
      if (!newFiber) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (!oldFiber) {
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        if (oldFiber && !newFiber.alternate) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (!previousNewFiber) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (step.done) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      return resultingFirstChild;
    }

    if (!oldFiber) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (; !step.done; newIdx++, step = newChildren.next()) {
        const newFiber = createChild(
          returnFiber,
          step.value,
          priority
        );
        if (!newFiber) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (!previousNewFiber) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(returnFiber, oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; !step.done; newIdx++, step = newChildren.next()) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        step.value,
        priority
      );
      if (newFiber) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (!previousNewFiber) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    return resultingFirstChild;
  }

  function reconcileSingleTextNode(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    textContent : string,
    priority : PriorityLevel
  ) : Fiber {
    // There's no need to check for keys on text nodes since we don't have a
    // way to define them.
    if (currentFirstChild && currentFirstChild.tag === HostText) {
      // We already have an existing node so let's just update it and delete
      // the rest.
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      const existing = useFiber(currentFirstChild, priority);
      existing.pendingProps = textContent;
      existing.return = returnFiber;
      return existing;
    }
    // The existing first child is not a text node so we need to create one
    // and delete the existing ones.
    deleteRemainingChildren(returnFiber, currentFirstChild);
    const created = createFiberFromText(textContent, priority);
    created.return = returnFiber;
    return created;
  }

  function reconcileSingleElement(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    element : ReactElement,
    priority : PriorityLevel
  ) : Fiber {
    const key = element.key;
    let child = currentFirstChild;
    while (child) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (child.type === element.type) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, priority);
          existing.ref = coerceRef(child, element);
          existing.pendingProps = element.props;
          existing.return = returnFiber;
          if (__DEV__) {
            existing._debugSource = element._source;
            existing._debugOwner = element._owner;
          }
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromElement(element, priority);
    created.ref = coerceRef(currentFirstChild, element);
    created.return = returnFiber;
    return created;
  }

  function reconcileSingleCoroutine(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    coroutine : ReactCoroutine,
    priority : PriorityLevel
  ) : Fiber {
    const key = coroutine.key;
    let child = currentFirstChild;
    while (child) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (child.tag === CoroutineComponent) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, priority);
          existing.pendingProps = coroutine;
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromCoroutine(coroutine, priority);
    created.return = returnFiber;
    return created;
  }

  function reconcileSingleYield(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    yieldNode : ReactYield,
    priority : PriorityLevel
  ) : Fiber {
    const key = yieldNode.key;
    let child = currentFirstChild;
    while (child) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (child.tag === YieldComponent) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, priority);
          existing.type = createUpdatedReifiedYield(
            child.type,
            yieldNode
          );
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const reifiedYield = createReifiedYield(yieldNode);
    const created = createFiberFromYield(yieldNode, priority);
    created.type = reifiedYield;
    created.return = returnFiber;
    return created;
  }

  function reconcileSinglePortal(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    portal : ReactPortal,
    priority : PriorityLevel
  ) : Fiber {
    const key = portal.key;
    let child = currentFirstChild;
    while (child) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (
          child.tag === HostPortal &&
          child.stateNode.containerInfo === portal.containerInfo &&
          child.stateNode.implementation === portal.implementation
        ) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, priority);
          existing.pendingProps = portal.children || [];
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromPortal(portal, priority);
    created.return = returnFiber;
    return created;
  }

  // This API will tag the children with the side-effect of the reconciliation
  // itself. They will be added to the side-effect list as we pass through the
  // children and the parent.
  function reconcileChildFibers(
    returnFiber : Fiber,
    currentFirstChild : ?Fiber,
    newChild : any,
    priority : PriorityLevel
  ) : ?Fiber {
    // This function is not recursive.
    // If the top level item is an array, we treat it as a set of children,
    // not as a fragment. Nested arrays on the other hand will be treated as
    // fragment nodes. Recursion happens at the normal flow.

    if (typeof newChild === 'string' || typeof newChild === 'number') {
      return placeSingleChild(reconcileSingleTextNode(
        returnFiber,
        currentFirstChild,
        '' + newChild,
        priority
      ));
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE:
          return placeSingleChild(reconcileSingleElement(
            returnFiber,
            currentFirstChild,
            newChild,
            priority
          ));

        case REACT_COROUTINE_TYPE:
          return placeSingleChild(reconcileSingleCoroutine(
            returnFiber,
            currentFirstChild,
            newChild,
            priority
          ));

        case REACT_YIELD_TYPE:
          return placeSingleChild(reconcileSingleYield(
            returnFiber,
            currentFirstChild,
            newChild,
            priority
          ));

        case REACT_PORTAL_TYPE:
          return placeSingleChild(reconcileSinglePortal(
            returnFiber,
            currentFirstChild,
            newChild,
            priority
          ));
      }

      if (isArray(newChild)) {
        return reconcileChildrenArray(
          returnFiber,
          currentFirstChild,
          newChild,
          priority
        );
      }

      if (getIteratorFn(newChild)) {
        return reconcileChildrenIterator(
          returnFiber,
          currentFirstChild,
          newChild,
          priority
        );
      }
    }

    // Remaining cases are all treated as empty.
    return deleteRemainingChildren(returnFiber, currentFirstChild);
  }

  return reconcileChildFibers;
}

exports.reconcileChildFibers = ChildReconciler(true, true);

exports.reconcileChildFibersInPlace = ChildReconciler(false, true);

exports.mountChildFibersInPlace = ChildReconciler(false, false);

exports.cloneChildFibers = function(current : ?Fiber, workInProgress : Fiber) : void {
  if (!workInProgress.child) {
    return;
  }
  if (current && workInProgress.child === current.child) {
    // We use workInProgress.child since that lets Flow know that it can't be
    // null since we validated that already. However, as the line above suggests
    // they're actually the same thing.
    let currentChild = workInProgress.child;
    // TODO: This used to reset the pending priority. Not sure if that is needed.
    // workInProgress.pendingWorkPriority = current.pendingWorkPriority;
    // TODO: The below priority used to be set to NoWork which would've
    // dropped work. This is currently unobservable but will become
    // observable when the first sibling has lower priority work remaining
    // than the next sibling. At that point we should add tests that catches
    // this.
    let newChild = cloneFiber(currentChild, currentChild.pendingWorkPriority);
    workInProgress.child = newChild;

    newChild.return = workInProgress;
    while (currentChild.sibling) {
      currentChild = currentChild.sibling;
      newChild = newChild.sibling = cloneFiber(
        currentChild,
        currentChild.pendingWorkPriority
      );
      newChild.return = workInProgress;
    }
    newChild.sibling = null;
  }

  // If there is no alternate, then we don't need to clone the children.
  // If the children of the alternate fiber is a different set, then we don't
  // need to clone. We need to reset the return fiber though since we'll
  // traverse down into them.
  let child = workInProgress.child;
  while (child) {
    child.return = workInProgress;
    child = child.sibling;
  }
};
