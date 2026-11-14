package service

import (
	"bytes"
	"encoding/json"
)

// openAIResponsesInputMayNeedOrphanCleanup only proves that cleanup is a no-op.
// Possible outputs still use the existing decoder and sanitizer, including its
// named standalone outputs, call/id fallback and item-reference rules. All byte
// spans below borrow the immutable request only for this synchronous call.
func openAIResponsesInputMayNeedOrphanCleanup(body []byte) bool {
	// Keep the old GJSON gate (first object and first input key, including a
	// garbage prefix) without parsing unrelated string values. GJSON allocates
	// while scanning large escaped strings even when the selected value is a
	// small array, which defeats this precheck's zero-copy contract.
	inputStart, inputEnd, inputIsArray, inputFound, escapedKey := findOpenAIResponsesInput(body)
	if !inputFound || !inputIsArray {
		return false
	}
	if !json.Valid(body) {
		// Preserve the existing decoder's malformed/trailing-JSON error path.
		return true
	}
	if escapedKey {
		// The full decoder is authoritative for escaped keys. Once an input
		// array is present, conservatively take the cleanup path instead of
		// materializing a decoded key just for this fast precheck.
		return true
	}
	if inputStart <= 0 || inputEnd > len(body) {
		return true
	}

	hasPreviousResponseID := false
	inputSeen, previousResponseIDSeen := false, false
	if !visitOpenAIResponsesOrphanPrecheckFields(body, func(key, value []byte) bool {
		switch string(key) {
		case `"input"`:
			if inputSeen {
				return false
			}
			inputSeen = true
		case `"previous_response_id"`:
			if previousResponseIDSeen {
				return false
			}
			previousResponseIDSeen = true
			if value[0] == '"' {
				if bytes.IndexByte(value, '\\') >= 0 {
					return false
				}
				hasPreviousResponseID = len(bytes.TrimSpace(value[1:len(value)-1])) != 0
			}
		}
		return true
	}) {
		// GJSON selects first duplicate keys; encoding/json selects the last.
		// Escaped keys and duplicate relevant keys conservatively use the latter.
		return true
	}
	if hasPreviousResponseID {
		return false
	}

	rawInput := body[inputStart:inputEnd]
	for i := 1; ; {
		i = skipOpenAIWSJSONSpace(rawInput, i)
		if rawInput[i] == ']' {
			return false
		}
		start := i
		switch rawInput[i] {
		case '{', '[', '"':
			i = skipOpenAIWSJSONValue(rawInput, i)
		default:
			// The shared object-value scanner stops at '}', whereas scalar
			// array members end at ']'. No scalar item can contain a tool output.
			for rawInput[i] != ',' && rawInput[i] != ']' {
				i++
			}
		}
		if rawInput[start] == '{' {
			typeSeen := false
			if !visitOpenAIResponsesOrphanPrecheckFields(rawInput[start:i], func(key, value []byte) bool {
				if string(key) != `"type"` {
					return true
				}
				if typeSeen {
					return false
				}
				typeSeen = true
				if value[0] != '"' {
					return true
				}
				if bytes.IndexByte(value, '\\') >= 0 {
					return false
				}
				return !isCodexToolCallOutputItemType(parseRawJSONView(value).Str)
			}) {
				return true
			}
		}
		i = skipOpenAIWSJSONSpace(rawInput, i)
		if rawInput[i] == ',' {
			i++
		}
	}
}

// findOpenAIResponsesInput finds the first top-level input value using only
// byte ranges. It mirrors the old GJSON lookup's first-object/first-key
// behavior, including malformed prefixes and duplicate keys.
func findOpenAIResponsesInput(body []byte) (start, end int, isArray, found, escapedKey bool) {
	objectStart := bytes.IndexByte(body, '{')
	arrayStart := bytes.IndexByte(body, '[')
	if objectStart < 0 || (arrayStart >= 0 && arrayStart < objectStart) {
		return 0, 0, false, false, false
	}
	i := objectStart + 1
	for {
		i = skipOpenAIWSJSONSpace(body, i)
		if i >= len(body) || body[i] == '}' {
			return 0, 0, false, false, escapedKey
		}
		if body[i] != '"' {
			return 0, 0, false, false, escapedKey
		}
		keyStart := i
		keyEnd := scanOpenAIWSJSONString(body, i)
		if keyEnd <= keyStart || keyEnd > len(body) || body[keyEnd-1] != '"' {
			return 0, 0, false, false, escapedKey
		}
		key := body[keyStart:keyEnd]
		keyIsInput := jsonKeyEqualsInput(key)
		if keyIsInput && bytes.IndexByte(key, '\\') >= 0 {
			escapedKey = true
		}
		i = skipOpenAIWSJSONSpace(body, keyEnd)
		if i >= len(body) || body[i] != ':' {
			return 0, 0, false, false, escapedKey
		}
		valueStart := skipOpenAIWSJSONSpace(body, i+1)
		if valueStart >= len(body) {
			return 0, 0, false, false, escapedKey
		}
		valueEnd := skipOpenAIWSJSONValue(body, valueStart)
		if valueEnd <= valueStart || valueEnd > len(body) {
			return 0, 0, false, false, escapedKey
		}
		if keyIsInput {
			return valueStart, valueEnd, body[valueStart] == '[', true, escapedKey
		}
		i = skipOpenAIWSJSONSpace(body, valueEnd)
		if i >= len(body) || body[i] != ',' {
			if i < len(body) && body[i] == '}' {
				return 0, 0, false, false, escapedKey
			}
			return 0, 0, false, false, escapedKey
		}
		i++
	}
}

func jsonKeyEqualsInput(key []byte) bool {
	if len(key) < 2 || key[0] != '"' || key[len(key)-1] != '"' {
		return false
	}
	const target = "input"
	targetIndex := 0
	for i := 1; i < len(key)-1; i++ {
		value := key[i]
		if value == '\\' {
			i++
			if i >= len(key)-1 {
				return false
			}
			switch key[i] {
			case '"', '\\', '/':
				value = key[i]
			case 'b':
				value = '\b'
			case 'f':
				value = '\f'
			case 'n':
				value = '\n'
			case 'r':
				value = '\r'
			case 't':
				value = '\t'
			case 'u':
				if i+4 >= len(key)-1 {
					return false
				}
				value = decodeASCIIJSONEscape(key[i+1 : i+5])
				i += 4
			default:
				return false
			}
		}
		if targetIndex >= len(target) || value != target[targetIndex] {
			return false
		}
		targetIndex++
	}
	return targetIndex == len(target)
}

func decodeASCIIJSONEscape(hex []byte) byte {
	if len(hex) != 4 {
		return 0
	}
	var value byte
	for _, digit := range hex {
		value <<= 4
		switch {
		case digit >= '0' && digit <= '9':
			value |= digit - '0'
		case digit >= 'a' && digit <= 'f':
			value |= digit - 'a' + 10
		case digit >= 'A' && digit <= 'F':
			value |= digit - 'A' + 10
		default:
			return 0
		}
	}
	return value
}

// visitOpenAIResponsesOrphanPrecheckFields visits an already-validated object
// without materializing unrelated strings (including large escaped content).
// Escaped keys are deliberately left to the full decoder rather than decoded
// into potentially request-sized temporary strings here.
func visitOpenAIResponsesOrphanPrecheckFields(object []byte, visit func(key, value []byte) bool) bool {
	i := skipOpenAIWSJSONSpace(object, 0) + 1
	for {
		i = skipOpenAIWSJSONSpace(object, i)
		if object[i] == '}' {
			return true
		}
		keyStart := i
		keyEnd := scanOpenAIWSJSONString(object, i)
		key := object[keyStart:keyEnd]
		if bytes.IndexByte(key, '\\') >= 0 {
			return false
		}
		i = skipOpenAIWSJSONSpace(object, keyEnd) + 1 // Valid JSON guarantees ':'.
		valueStart := skipOpenAIWSJSONSpace(object, i)
		i = skipOpenAIWSJSONValue(object, valueStart)
		if !visit(key, bytes.TrimSpace(object[valueStart:i])) {
			return false
		}
		i = skipOpenAIWSJSONSpace(object, i)
		if object[i] == ',' {
			i++
		}
	}
}
