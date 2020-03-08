import { Position } from './../common/motion/position';
import { Range } from './../common/motion/range';
import { Mode } from './../mode/mode';
import { RegisterMode } from './../register/register';
import { VimState } from './../state/vimState';
import { TextEditor } from './../textEditor';
import { RegisterAction } from './base';
import { BaseMovement, IMovement } from './baseMotion';
import {
  MoveAClosingCurlyBrace,
  MoveADoubleQuotes,
  MoveAParentheses,
  MoveASingleQuotes,
  MoveASquareBracket,
  MoveABacktick,
  MoveAroundTag,
  ExpandingSelection,
} from './motion';
import { ChangeOperator } from './operator';
import { fail } from 'assert';
import { ConsoleForElectron } from 'winston-console-for-electron';

export abstract class TextObjectMovement extends BaseMovement {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualBlock];

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    const res = (await this.execAction(position, vimState)) as IMovement;
    // Since we need to handle leading spaces, we cannot use MoveWordBegin.execActionForOperator
    // In normal mode, the character on the stop position will be the first character after the operator executed
    // and we do left-shifting in operator-pre-execution phase, here we need to right-shift the stop position accordingly.
    res.stop = new Position(res.stop.line, res.stop.character + 1);

    return res;
  }
}

@RegisterAction
export class SelectWord extends TextObjectMovement {
  keys = ['a', 'w'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;
    const currentChar = TextEditor.getCharAt(position);

    if (/\s/.test(currentChar)) {
      start = position.getLastWordEnd().getRight();
      stop = position.getCurrentWordEnd();
    } else {
      stop = position.getWordRight();
      // If the next word is not at the beginning of the next line, we want to pretend it is.
      // This is because 'aw' has two fundamentally different behaviors distinguished by whether
      // the next word is directly after the current word, as described in the following comment.
      // The only case that's not true is in cases like #1350.
      if (stop.isEqual(stop.getFirstLineNonBlankChar())) {
        stop = stop.getLineBegin();
      }
      stop = stop.getLeftThroughLineBreaks().getLeftIfEOL();
      // If we aren't separated from the next word by whitespace(like in "horse ca|t,dog" or at the end of the line)
      // then we delete the spaces to the left of the current word. Otherwise, we delete to the right.
      // Also, if the current word is the leftmost word, we only delete from the start of the word to the end.
      if (
        stop.isEqual(position.getCurrentWordEnd(true)) &&
        !position.getWordLeft(true).isEqual(position.getFirstLineNonBlankChar()) &&
        vimState.recordedState.count === 0
      ) {
        start = position.getLastWordEnd().getRight();
      } else {
        start = position.getWordLeft(true);
      }
    }

    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor position is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getWordLeft(true);
        } else {
          stop = position.getLastWordEnd().getRight();
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectABigWord extends TextObjectMovement {
  keys = ['a', 'W'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
      start = position.getLastBigWordEnd().getRight();
      stop = position.getCurrentBigWordEnd();
    } else {
      // Check 'aw' code for much of the reasoning behind this logic.
      const nextWord = position.getBigWordRight();
      if (
        (nextWord.line > position.line || nextWord.isAtDocumentEnd()) &&
        vimState.recordedState.count === 0
      ) {
        if (position.getLastBigWordEnd().isLineBeginning()) {
          start = position.getLastBigWordEnd();
        } else {
          start = position.getLastBigWordEnd().getRight();
        }
        stop = position.getLineEnd();
      } else if (
        (nextWord.isEqual(nextWord.getFirstLineNonBlankChar()) || nextWord.isLineEnd()) &&
        vimState.recordedState.count === 0
      ) {
        start = position.getLastWordEnd().getRight();
        stop = position.getLineEnd();
      } else {
        start = position.getBigWordLeft(true);
        stop = position.getBigWordRight().getLeft();
      }
    }
    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getBigWordLeft();
        } else {
          stop = position.getLastBigWordEnd().getRight();
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

/**
 * This is a custom action that I (johnfn) added. It selects procedurally
 * larger blocks. e.g. if you had "blah (foo [bar 'ba|z'])" then it would
 * select 'baz' first. If you pressed af again, it'd then select [bar 'baz'],
 * and if you did it a third time it would select "(foo [bar 'baz'])".
 *
 * Very similar is the now built-in `editor.action.smartSelect.expand`
 */
@RegisterAction
export class SelectAnExpandingBlock extends ExpandingSelection {
  keys = ['a', 'f'];
  modes = [Mode.Visual, Mode.VisualLine];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    const blocks = [
      new MoveADoubleQuotes(),
      new MoveASingleQuotes(),
      new MoveABacktick(),
      new MoveAClosingCurlyBrace(),
      new MoveAParentheses(),
      new MoveASquareBracket(),
      new MoveAroundTag(),
    ];
    // ideally no state would change as we test each of the possible expansions
    // a deep copy of vimState could work here but may be expensive
    let ranges: IMovement[] = [];
    for (const block of blocks) {
      const cursorPos = new Position(position.line, position.character);
      const cursorStartPos = new Position(
        vimState.cursorStartPosition.line,
        vimState.cursorStartPosition.character
      );
      ranges.push(await block.execAction(cursorPos, vimState));
      vimState.cursorStartPosition = cursorStartPos;
    }

    ranges = ranges.filter(range => {
      return !range.failed;
    });

    let smallestRange: Range | undefined = undefined;

    for (const iMotion of ranges) {
      const currentSelectedRange = new Range(
        vimState.cursorStartPosition,
        vimState.cursorStopPosition
      );
      if (iMotion.failed) {
        continue;
      }

      const range = Range.FromIMovement(iMotion);
      let contender: Range | undefined = undefined;

      if (
        range.start.isBefore(currentSelectedRange.start) &&
        range.stop.isAfter(currentSelectedRange.stop)
      ) {
        if (!smallestRange) {
          contender = range;
        } else {
          if (range.start.isAfter(smallestRange.start) && range.stop.isBefore(smallestRange.stop)) {
            contender = range;
          }
        }
      }

      if (contender) {
        const areTheyEqual =
          contender.equals(new Range(vimState.cursorStartPosition, vimState.cursorStopPosition)) ||
          (vimState.currentMode === Mode.VisualLine &&
            contender.start.line === vimState.cursorStartPosition.line &&
            contender.stop.line === vimState.cursorStopPosition.line);

        if (!areTheyEqual) {
          smallestRange = contender;
        }
      }
    }
    if (!smallestRange) {
      return {
        start: vimState.cursorStartPosition,
        stop: vimState.cursorStopPosition,
      };
    } else {
      // revert relevant state changes
      vimState.cursorStartPosition = new Position(
        smallestRange.start.line,
        smallestRange.start.character
      );
      vimState.cursorStopPosition = new Position(
        smallestRange.stop.line,
        smallestRange.stop.character
      );
      vimState.recordedState.operatorPositionDiff = undefined;
      return {
        start: smallestRange.start,
        stop: smallestRange.stop,
      };
    }
  }
}

@RegisterAction
export class SelectInnerWord extends TextObjectMovement {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['i', 'w'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;
    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
      start = position.getLastWordEnd().getRight();
      stop = position.getWordRight().getLeftThroughLineBreaks();
    } else {
      start = position.getWordLeft(true);
      stop = position.getCurrentWordEnd(true);
    }

    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getLastWordEnd().getRight();
        } else {
          stop = position.getWordLeft(true);
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectInnerBigWord extends TextObjectMovement {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['i', 'W'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;
    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
      start = position.getLastBigWordEnd().getRight();
      stop = position.getBigWordRight().getLeft();
    } else {
      start = position.getBigWordLeft(true);
      stop = position.getCurrentBigWordEnd(true);
    }

    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getLastBigWordEnd().getRight();
        } else {
          stop = position.getBigWordLeft();
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectSentence extends TextObjectMovement {
  keys = ['a', 's'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentSentenceBegin = position.getSentenceBegin({ forward: false });
    const currentSentenceNonWhitespaceEnd = currentSentenceBegin.getCurrentSentenceEnd();

    if (currentSentenceNonWhitespaceEnd.isBefore(position)) {
      // The cursor is on a trailing white space.
      start = currentSentenceNonWhitespaceEnd.getRight();
      stop = currentSentenceBegin.getSentenceBegin({ forward: true }).getCurrentSentenceEnd();
    } else {
      const nextSentenceBegin = currentSentenceBegin.getSentenceBegin({ forward: true });

      // If the sentence has no trailing white spaces, `as` should include its leading white spaces.
      if (nextSentenceBegin.isEqual(currentSentenceBegin.getCurrentSentenceEnd())) {
        start = currentSentenceBegin
          .getSentenceBegin({ forward: false })
          .getCurrentSentenceEnd()
          .getRight();
        stop = nextSentenceBegin;
      } else {
        start = currentSentenceBegin;
        stop = nextSentenceBegin.getLeft();
      }
    }

    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting sentences in reverser order.
        if (currentSentenceNonWhitespaceEnd.isAfter(vimState.cursorStopPosition)) {
          stop = currentSentenceBegin
            .getSentenceBegin({ forward: false })
            .getCurrentSentenceEnd()
            .getRight();
        } else {
          stop = currentSentenceBegin;
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectInnerSentence extends TextObjectMovement {
  keys = ['i', 's'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentSentenceBegin = position.getSentenceBegin({ forward: false });
    const currentSentenceNonWhitespaceEnd = currentSentenceBegin.getCurrentSentenceEnd();

    if (currentSentenceNonWhitespaceEnd.isBefore(position)) {
      // The cursor is on a trailing white space.
      start = currentSentenceNonWhitespaceEnd.getRight();
      stop = currentSentenceBegin.getSentenceBegin({ forward: true }).getLeft();
    } else {
      start = currentSentenceBegin;
      stop = currentSentenceNonWhitespaceEnd;
    }

    if (
      vimState.currentMode === Mode.Visual &&
      !vimState.cursorStopPosition.isEqual(vimState.cursorStartPosition)
    ) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorStopPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting sentences in reverser order.
        if (currentSentenceNonWhitespaceEnd.isAfter(vimState.cursorStopPosition)) {
          stop = currentSentenceBegin;
        } else {
          stop = currentSentenceNonWhitespaceEnd.getRight();
        }
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectParagraph extends TextObjectMovement {
  keys = ['a', 'p'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    vimState.currentRegisterMode = RegisterMode.LineWise;

    let start: Position;
    const currentParagraphBegin = position.getCurrentParagraphBeginning(true);

    if (position.isLineWhite()) {
      // The cursor is at an empty line, it can be both the start of next paragraph and the end of previous paragraph
      start = position.getCurrentParagraphBeginning(true).getCurrentParagraphEnd(true);
    } else {
      if (currentParagraphBegin.isLineBeginning() && currentParagraphBegin.isLineEnd()) {
        start = currentParagraphBegin.getRightThroughLineBreaks();
      } else {
        start = currentParagraphBegin;
      }
    }

    // Include additional blank lines.
    let stop = position.getCurrentParagraphEnd(true);
    while (stop.line < TextEditor.getLineCount() - 1 && stop.getDown(0).isLineWhite()) {
      stop = stop.getDown(0);
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

@RegisterAction
export class SelectInnerParagraph extends TextObjectMovement {
  keys = ['i', 'p'];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    vimState.currentRegisterMode = RegisterMode.LineWise;

    let start: Position;
    let stop: Position;

    if (position.isLineWhite()) {
      // The cursor is at an empty line, so white lines are the paragraph.
      start = position.getLineBegin();
      stop = position.getLineEnd();
      while (start.line > 0 && start.getUp(0).isLineWhite()) {
        start = start.getUp(0);
      }
      while (stop.line < TextEditor.getLineCount() - 1 && stop.getDown(0).isLineWhite()) {
        stop = stop.getDown(0);
      }
    } else {
      const currentParagraphBegin = position.getCurrentParagraphBeginning(true);
      stop = position.getCurrentParagraphEnd(true);
      if (currentParagraphBegin.isLineWhite()) {
        start = currentParagraphBegin.getRightThroughLineBreaks();
      } else {
        start = currentParagraphBegin;
      }

      // Exclude additional blank lines.
      while (stop.line > 0 && stop.isLineWhite()) {
        stop = stop.getUp(0).getLineEnd();
      }
    }

    return {
      start: start,
      stop: stop,
    };
  }
}

abstract class IndentObjectMatch extends TextObjectMovement {
  setsDesiredColumnToEOL = true;

  protected includeLineAbove = false;
  protected includeLineBelow = false;

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    const isChangeOperator = vimState.recordedState.operator instanceof ChangeOperator;
    const firstValidLineNumber = IndentObjectMatch.findFirstValidLine(position);
    const firstValidLine = TextEditor.getLineAt(new Position(firstValidLineNumber, 0));
    const cursorIndent = firstValidLine.firstNonWhitespaceCharacterIndex;

    let startLineNumber = IndentObjectMatch.findRangeStartOrEnd(
      firstValidLineNumber,
      cursorIndent,
      -1
    );
    let endLineNumber = IndentObjectMatch.findRangeStartOrEnd(
      firstValidLineNumber,
      cursorIndent,
      1
    );

    // Adjust the start line as needed.
    if (this.includeLineAbove) {
      startLineNumber -= 1;
    }
    // Check for OOB.
    if (startLineNumber < 0) {
      startLineNumber = 0;
    }

    // Adjust the end line as needed.
    if (this.includeLineBelow) {
      endLineNumber += 1;
    }
    // Check for OOB.
    if (endLineNumber > TextEditor.getLineCount() - 1) {
      endLineNumber = TextEditor.getLineCount() - 1;
    }

    // If initiated by a change operation, adjust the cursor to the indent level
    // of the block.
    let startCharacter = 0;
    if (isChangeOperator) {
      startCharacter = TextEditor.getLineAt(new Position(startLineNumber, 0))
        .firstNonWhitespaceCharacterIndex;
    }
    // TextEditor.getLineMaxColumn throws when given line 0, which we don't
    // care about here since it just means this text object wouldn't work on a
    // single-line document.
    let endCharacter: number;
    if (endLineNumber === TextEditor.getLineCount() - 1 || vimState.currentMode === Mode.Visual) {
      endCharacter = TextEditor.getLineLength(endLineNumber);
    } else {
      endCharacter = 0;
      endLineNumber++;
    }
    return {
      start: new Position(startLineNumber, startCharacter),
      stop: new Position(endLineNumber, endCharacter),
    };
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    return this.execAction(position, vimState);
  }

  /**
   * Searches up from the cursor for the first non-empty line.
   */
  public static findFirstValidLine(cursorPosition: Position): number {
    for (let i = cursorPosition.line; i >= 0; i--) {
      const line = TextEditor.getLineAt(new Position(i, 0));

      if (!line.isEmptyOrWhitespace) {
        return i;
      }
    }

    return cursorPosition.line;
  }

  /**
   * Searches up or down from a line finding the first with a lower indent level.
   */
  public static findRangeStartOrEnd(
    startIndex: number,
    cursorIndent: number,
    step: -1 | 1
  ): number {
    let i = startIndex;
    let ret = startIndex;
    const end = step === 1 ? TextEditor.getLineCount() : -1;

    for (; i !== end; i += step) {
      const line = TextEditor.getLineAt(new Position(i, 0));
      const isLineEmpty = line.isEmptyOrWhitespace;
      const lineIndent = line.firstNonWhitespaceCharacterIndex;

      if (lineIndent < cursorIndent && !isLineEmpty) {
        break;
      }

      ret = i;
    }

    return ret;
  }
}

@RegisterAction
class InsideIndentObject extends IndentObjectMatch {
  keys = ['i', 'i'];
}

@RegisterAction
class InsideIndentObjectAbove extends IndentObjectMatch {
  keys = ['a', 'i'];
  includeLineAbove = true;
}

@RegisterAction
class InsideIndentObjectBoth extends IndentObjectMatch {
  keys = ['a', 'I'];
  includeLineAbove = true;
  includeLineBelow = true;
}

abstract class SelectArgument extends TextObjectMovement {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['i', 'a'];

  // Depending on the language or context, it may be useful to have
  // custom delimiters, such as ';' or '{}'
  static openingDelimiters = ['(', '['];
  static closingDelimiters = [')', ']'];
  static delimiters = [','];

  protected selectAround = false;

  // Requirement is that below example still works as expected, i.e.
  // when we have nested pairs of parens
  //
  //        ( a, b, (void*) | c(void*, void*), a)
  //
  // Procedure:
  //
  // 1.  Find delimiters left and right
  // 1.2 Walk left until we find a comma or an opening paren, that does not
  //     have a matching closed one. This way we can ignore pairs
  //     of parentheses which are part of the current argument.
  // 1.2 Vice versa for walking right.
  // 2.  Depending on our mode (inner or around), improve the delimiter
  //     locations for most consistent behaviour, especially in case of
  //     multi-line statements.

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let cursorStartPos = new Position(
      vimState.cursorStartPosition.line,
      vimState.cursorStartPosition.character
    );
    // maintain current selection on failure
    const failure = { start: cursorStartPos, stop: position, failed: true };

    // When the cursor is on a delimiter already, pre-advance the cursor,
    // so that our search does not fail. We always advance to the next argument,
    // in case of opening delimiters or regular delimiters, and advance to the
    // previous on closing delimiters.
    let leftSearchStartPosition = new Position(
      vimState.cursorStartPosition.line,
      vimState.cursorStartPosition.character
    );
    let rightSearchStartPosition = new Position(
      vimState.cursorStartPosition.line,
      vimState.cursorStartPosition.character
    );
    if (
      SelectArgument.delimiters.includes(TextEditor.getCharAt(position)) ||
      SelectArgument.openingDelimiters.includes(TextEditor.getCharAt(position))
    ) {
      rightSearchStartPosition = position.getRightThroughLineBreaks(true);
    } else if (SelectArgument.closingDelimiters.includes(TextEditor.getCharAt(position))) {
      leftSearchStartPosition = position.getLeftThroughLineBreaks(true);
    }

    const leftDelimiterPosition = SelectInnerArgument.getLeftDelimiter(leftSearchStartPosition);
    const rightDelimiterPosition = SelectInnerArgument.getRightDelimiter(rightSearchStartPosition);

    if (leftDelimiterPosition === null || rightDelimiterPosition === null) {
      return failure;
    }

    let start: Position;
    let stop: Position;

    if (this.selectAround) {
      // Edge-case:
      // Ensure we do not delete anything if we have an empty argument list, e.g. "()"
      let isEmptyArgumentList =
        leftDelimiterPosition.getRight().isEqual(rightDelimiterPosition) &&
        SelectArgument.openingDelimiters.includes(TextEditor.getCharAt(leftDelimiterPosition)) &&
        SelectArgument.closingDelimiters.includes(TextEditor.getCharAt(rightDelimiterPosition));
      if (isEmptyArgumentList) {
        return failure;
      }

      let cursorIsInLastArgument = SelectArgument.closingDelimiters.includes(
        TextEditor.getCharAt(rightDelimiterPosition)
      );

      // If we are on the right most argument, we delete the left delimiter
      // along with the argument.
      //
      // In any other case we delete the right delimiter.
      if (cursorIsInLastArgument) {
        let thereIsOnlyOneArgument = SelectArgument.openingDelimiters.includes(
          TextEditor.getCharAt(leftDelimiterPosition)
        );

        // It may be that there is only a single argument.
        // In that case we need to inset the left position as well.
        if (thereIsOnlyOneArgument) {
          start = leftDelimiterPosition.getRightThroughLineBreaks(true);
        } else {
          start = leftDelimiterPosition;
        }

        stop = rightDelimiterPosition.getLeftThroughLineBreaks(true);
      } else {
        start = leftDelimiterPosition.getRightThroughLineBreaks(true);
        stop = rightDelimiterPosition;
      }
    } else {
      // Multi-line UX-boost:
      // When the left delimiter is at the end of the line, we can skip over
      // to the next line. This pre-advance prevents the cursor staying
      // right behind the delimiter on the line above.
      start = leftDelimiterPosition;
      if (leftDelimiterPosition.getRight().isLineEnd()) {
        start = start.getRightThroughLineBreaks(true);
      }
      start = start.getRightThroughLineBreaks(true);
      stop = rightDelimiterPosition.getLeftThroughLineBreaks(true);
    }

    // Handle case when cursor is not inside the anticipated movement range
    if (position.isBefore(start)) {
      vimState.recordedState.operatorPositionDiff = start.subtract(position);
    }
    vimState.cursorStartPosition = start;

    return {
      start: start,
      stop: stop,
    };
  }

  public static getLeftDelimiter(position: Position): Position | null {
    let leftDelimiterPosition: Position | null = null;
    let leftWalkPos = position;
    let closedParensCount = 0;
    while (true) {
      let char = TextEditor.getCharAt(leftWalkPos);
      if (closedParensCount === 0) {
        if (
          SelectArgument.openingDelimiters.includes(char) ||
          SelectArgument.delimiters.includes(char)
        ) {
          // We have found the left most delimiter or the first proper delimiter
          // in our cursor's list 'depth' and thus can abort.
          leftDelimiterPosition = leftWalkPos;
          break;
        }
      }
      if (SelectArgument.closingDelimiters.includes(char)) {
        closedParensCount++;
      }
      if (SelectArgument.openingDelimiters.includes(char)) {
        closedParensCount--;
      }

      if (leftWalkPos.isAtDocumentBegin()) {
        break;
      }

      leftWalkPos = leftWalkPos.getLeftThroughLineBreaks(true);
    }

    return leftDelimiterPosition;
  }

  public static getRightDelimiter(position: Position): Position | null {
    let rightDelimiterPosition: Position | null = null;
    let rightWalkPos = position;
    let openedParensCount = 0;

    while (true) {
      let char = TextEditor.getCharAt(rightWalkPos);
      if (openedParensCount === 0) {
        if (
          SelectArgument.closingDelimiters.includes(char) ||
          SelectArgument.delimiters.includes(char)
        ) {
          rightDelimiterPosition = rightWalkPos;
          break;
        }
      }
      if (SelectArgument.openingDelimiters.includes(char)) {
        openedParensCount++;
      }
      if (SelectArgument.closingDelimiters.includes(char)) {
        openedParensCount--;
      }

      if (rightWalkPos.isAtDocumentEnd()) {
        break;
      }

      // We need to include the EOL so that isAtDocumentEnd actually
      // becomes true.
      rightWalkPos = rightWalkPos.getRightThroughLineBreaks(true);
    }

    return rightDelimiterPosition;
  }
}

@RegisterAction
export class SelectInnerArgument extends SelectArgument {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['i', 'a'];
}

@RegisterAction
export class SelectAroundArgument extends SelectArgument {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['a', 'a'];
  selectAround = true;
}
