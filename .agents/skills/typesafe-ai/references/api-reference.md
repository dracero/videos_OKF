# TypeSafe AI (Jev / System One) API Reference

## 1. Native API Endpoint

- **Endpoint**: `POST https://api.typesafe.ai/v1/systemone`
- **Headers**:
  ```http
  Authorization: Bearer <TYPESAFE_API_KEY>
  Content-Type: application/json
  ```

---

## 2. Request Schema

```typescript
interface SystemOneRequest {
  // Input context under evaluation (string or key-value object)
  state: string | Record<string, any>;
  
  // Declared typed questions to evaluate against the state
  questions: {
    [questionKey: string]: ChoiceQuestion | NoulQuestion | ScoreQuestion;
  };
}
```

### Question Types

#### `ChoiceQuestion`
Selects exactly one label from a dictionary of options (up to 255 items).
```typescript
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>; // { [labelKey]: "description of criteria" }
}
```

#### `NoulQuestion`
Evaluates a probabilistic assertion (yes/no probability between 0.0 and 1.0).
```typescript
interface NoulQuestion {
  type: "noul";
  instructions: string; // The assertion to evaluate against state
}
```

#### `ScoreQuestion`
Evaluates the state on an ordered spectrum of criteria (between 2 and 10 levels).
```typescript
interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[]; // Ordered list of descriptions from lowest to highest
}
```

---

## 3. Response Schema

```typescript
interface SystemOneResponse {
  id: string;
  model: "jev-1" | string;
  answers: {
    [questionKey: string]: {
      // For choice
      choice?: string;
      
      // For noul
      noul?: number; // 0.0 to 1.0 probability
      
      // For score
      score?: number; // numeric value on spectrum
      
      // Calibrated probabilities across all possible values
      probabilities: Record<string, number>;
      
      // Statistical confidence (0.0 to 1.0)
      confidence: number;
    };
  };
  usage: {
    input_tokens: number;
    output_tokens: number; // typically 0
  };
}
```

---

## 4. Best Practices & Guidelines

1. **State Cleanliness**:
   - Provide concise, informative text (transcripts, document headers, user queries).
   - Avoid injecting unnecessary metadata that adds token overhead without semantic value.
2. **Criteria Disambiguation**:
   - In `choice`, make criteria mutually exclusive and clearly distinct.
   - In `score`, ensure steps represent an increasing or decreasing order of intensity or complexity.
3. **Thresholding with Confidence**:
   - Use `confidence` alongside `choice` or `noul` to implement fallback routing:
     ```javascript
     if (res.answers.topic.confidence < 0.6) {
       // Fall back to general search or manual review
     }
     ```
4. **Performance & Batching**:
   - When evaluating multiple chunks, use `Promise.all` with a small concurrency limit (e.g., 5-10 requests concurrently) to keep end-to-end latency below 300ms.
