import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

function AiFlightAgent() {
  const [tailwindLoaded, setTailwindLoaded] = useState(false);
  
  // Chat messages and conversation
  const [messages, setMessages] = useStorage('flight-chat-messages', [], { scope: 'user' });
  const [userInput, setUserInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Flight search results
  const [currentFlights, setCurrentFlights] = useState([]);
  const [searchParams, setSearchParams] = useState(null);
  
  // Manual form toggle
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState({
    from: '',
    to: '',
    date: '',
    returnDate: '',
    adults: 1
  });
  
  // Search history for RAG
  const [searchHistory, setSearchHistory] = useStorage('flight-search-history', [], { scope: 'user' });
  
  // Saved searches for price tracking
  const [savedSearches, setSavedSearches] = useStorage('flight-saved-searches', [], { scope: 'user' });
  
  // User preferences (AI learns from choices)
  const [preferences, setPreferences] = useStorage('flight-preferences', {
    preferredAirlines: [],
    maxStops: null,
    maxPrice: null,
    directOnly: false,
    priorityWeights: { price: 0.4, time: 0.3, comfort: 0.3 } // Multi-criteria scoring
  }, { scope: 'user' });
  
  // Advanced search options
  const [searchMode, setSearchMode] = useState('specific'); // 'specific' or 'flexible'
  const [flexibleDateRange, setFlexibleDateRange] = useState({ start: '', end: '' });
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!document.getElementById('tailwind-script')) {
      const tailwindScript = document.createElement('script');
      tailwindScript.id = 'tailwind-script';
      tailwindScript.src = 'https://cdn.tailwindcss.com';
      tailwindScript.onload = () => {
        setTimeout(() => setTailwindLoaded(true), 100);
      };
      document.head.appendChild(tailwindScript);
    } else {
      setTailwindLoaded(true);
    }
  }, []);

  // Set white background for scrollable content
  useEffect(() => {
    document.body.style.background = '#ffffff';
    document.documentElement.style.minHeight = '100%';
    return () => { 
      document.body.style.background = ''; 
      document.documentElement.style.minHeight = ''; 
    };
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = useCallback((role, content, flightData = null) => {
    setMessages(prev => [...prev, {
      id: Date.now() + Math.random(),
      role,
      content,
      flightData,
      timestamp: new Date().toISOString()
    }]);
  }, [setMessages]);

  const buildConversationContext = () => {
    // Build context from recent conversation and search history
    let context = '';
    
    // Add recent messages (last 5 user messages and responses)
    const recentMessages = messages.slice(-10);
    if (recentMessages.length > 0) {
      context += '\n\nRECENT CONVERSATION:\n';
      recentMessages.forEach(msg => {
        if (msg.role === 'user' || (!msg.flightData && msg.role === 'assistant')) {
          context += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
        }
      });
    }
    
    // Add recent search history (last 3 searches)
    const recentSearches = searchHistory.slice(-3);
    if (recentSearches.length > 0) {
      context += '\n\nPREVIOUS SEARCHES (use these for context if user makes follow-up requests):\n';
      recentSearches.forEach((search, idx) => {
        context += `${idx + 1}. ${search.from} → ${search.to} on ${search.date}`;
        if (search.returnDate) context += ` (return ${search.returnDate})`;
        if (search.resultCount !== undefined) context += ` [${search.resultCount} results found]`;
        context += '\n';
      });
    }
    
    return context;
  };

  const parseFlightRequest = async (userMessage) => {
    try {
      const currentYear = new Date().getFullYear();
      const today = new Date().toISOString().split('T')[0];
      const conversationContext = buildConversationContext();
      
      const prompt = `You are a flight search assistant with memory of previous conversations and searches. Extract flight search parameters from the user's request using context when available.
${conversationContext}

CRITICAL INSTRUCTIONS FOR RAG:
- If user references previous searches (e.g., "cheaper options", "earlier", "tomorrow", "same route"), USE the previous search parameters as baseline
- Understand follow-up questions: "show me direct flights only", "what about next week?", "find something cheaper"
- For "from" and "to", use standard airport codes (JFK, LAX, LHR) or city names (New York, Los Angeles, London)
- For dates, ALWAYS use YYYY-MM-DD format. Today is ${today}. Current year is ${currentYear}.
- Calculate relative dates: "tomorrow" = ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}, "next week" = add 7 days, etc.

Return ONLY a JSON object:
{
  "from": "airport/city (infer from context if not specified)",
  "to": "airport/city (infer from context if not specified)",
  "date": "YYYY-MM-DD",
  "returnDate": "YYYY-MM-DD or null",
  "adults": 1,
  "tripType": "round-trip" or "one-way",
  "intent": "search" or "clarification_needed" or "refinement",
  "isFollowUp": true/false,
  "missingInfo": [],
  "friendlyResponse": "acknowledge context if follow-up, e.g. 'Looking for cheaper flights from NYC to Paris...'"
}

Current user request: "${userMessage}"

EXAMPLES WITH CONTEXT:
1. First search: "NYC to Paris June 15" → normal search
2. Follow-up: "what about tomorrow?" → Use NYC → Paris, calculate tomorrow's date, isFollowUp: true
3. Follow-up: "show me direct flights" → Use previous search, intent: "refinement", mention it's filtering previous search
4. Follow-up: "cheaper options" → Use previous search, isFollowUp: true, explain searching for cheaper alternatives

If missing critical info AND can't infer from context, set intent to "clarification_needed".`;

      const response = await miyagiAPI.post('/generate-text', {
        prompt,
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.3
      });

      if (response.success) {
        const jsonMatch = response.data.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log('Parsed flight request with RAG context:', parsed);
          console.log('Context used:', conversationContext);
          return parsed;
        }
      }
      return null;
    } catch (error) {
      console.error('Error parsing request:', error);
      return null;
    }
  };

  const searchFlights = async (params) => {
    try {
      const searchQuery = {
        from: params.from,
        to: params.to,
        date: params.date,
        adults: params.adults || 1
      };

      if (params.returnDate) {
        searchQuery.returnDate = params.returnDate;
      }

      console.log('Searching flights with params:', searchQuery);
      const response = await miyagiAPI.get('/flights', searchQuery);
      console.log('Flight search response:', response);

      if (response.success && response.data?.items) {
        const results = response.data.items;
        
        // Save to search history for RAG
        setSearchHistory(prev => [...prev, {
          ...searchQuery,
          timestamp: new Date().toISOString(),
          resultCount: results.length
        }]);
        
        return results;
      }
      
      // Return error details if available
      if (response.error) {
        throw new Error(response.error);
      }
      
      return [];
    } catch (error) {
      console.error('Error searching flights:', error);
      throw error;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!userInput.trim() || isProcessing) return;

    const userMessage = userInput.trim();
    setUserInput('');
    setIsProcessing(true);

    // Add user message
    addMessage('user', userMessage);

    try {
      // Parse the request with AI
      const parsed = await parseFlightRequest(userMessage);

      if (!parsed) {
        addMessage('assistant', "I'm having trouble understanding that request. Could you try rephrasing? For example: 'Find flights from New York to London on 2026-06-15'");
        setIsProcessing(false);
        return;
      }

      // Add AI response
      addMessage('assistant', parsed.friendlyResponse);

      // If we need clarification, stop here
      if (parsed.intent === 'clarification_needed') {
        setIsProcessing(false);
        return;
      }

      // Validate we have all required fields
      if (!parsed.from || !parsed.to || !parsed.date) {
        addMessage('assistant', `I need more information:\n${!parsed.from ? '• Origin city or airport\n' : ''}${!parsed.to ? '• Destination city or airport\n' : ''}${!parsed.date ? '• Travel date (YYYY-MM-DD)\n' : ''}Please provide these details.`);
        setIsProcessing(false);
        return;
      }

      // Search for flights
      addMessage('assistant', `🔍 Searching for flights from ${parsed.from} to ${parsed.to} on ${parsed.date}...`);
      
      try {
        const flights = await searchFlights(parsed);

        if (flights.length === 0) {
          addMessage('assistant', `No flights found for ${parsed.from} → ${parsed.to} on ${parsed.date}.\n\nTips:\n• Try using full city names (e.g., "New York" instead of "NYC")\n• Use nearby airports (e.g., "JFK", "LaGuardia", "Newark")\n• Try different dates\n• Ensure the date is in the future`);
        } else {
          // Score and rank flights
          const scoredFlights = flights.map(flight => ({
            ...flight,
            score: scoreFlightMultiCriteria(flight, flights)
          })).sort((a, b) => b.score.total - a.score.total);

          setCurrentFlights(scoredFlights);
          setSearchParams(parsed);
          
          // Generate explanation for top flight
          const topFlightExplanation = await generateFlightExplanation(scoredFlights[0], scoredFlights, parsed);
          
          let message = `Found ${flights.length} flight options! Ranked by your preferences (price, time, comfort).`;
          if (topFlightExplanation) {
            message += `\n\n✨ Top Pick: ${topFlightExplanation}`;
          }
          
          addMessage('assistant', message, { flights: scoredFlights, params: parsed });
        }
      } catch (error) {
        addMessage('assistant', `Error searching flights: ${error.message}\n\nPlease try:\n• Using full city names (e.g., "Los Angeles" not "LA")\n• Major airports (e.g., "JFK", "LAX", "LHR")\n• Date format: YYYY-MM-DD (e.g., 2026-06-15)`);
      }
    } catch (error) {
      console.error('Handle submit error:', error);
      addMessage('assistant', `Something went wrong: ${error.message}. Please try again.`);
    }

    setIsProcessing(false);
  };

  const formatDuration = (minutes) => {
    if (!minutes) return 'N/A';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const formatPrice = (price) => {
    if (!price) return 'N/A';
    if (typeof price === 'number') return `$${price}`;
    return price;
  };

  // Multi-criteria scoring system
  const scoreFlightMultiCriteria = (flight, allFlights) => {
    if (!flight || allFlights.length === 0) return { total: 0, breakdown: {} };

    // Extract numeric price
    const getNumericPrice = (p) => {
      if (typeof p === 'number') return p;
      if (typeof p === 'string') {
        const match = p.match(/[\d,]+/);
        return match ? parseFloat(match[0].replace(/,/g, '')) : 999999;
      }
      return 999999;
    };

    const prices = allFlights.map(f => getNumericPrice(f.price)).filter(p => p < 999999);
    const durations = allFlights.map(f => f.duration).filter(d => d);
    
    const minPrice = Math.min(...prices, 999999);
    const maxPrice = Math.max(...prices, 0);
    const minDuration = Math.min(...durations, 9999);
    const maxDuration = Math.max(...durations, 0);

    const price = getNumericPrice(flight.price);
    const duration = flight.duration || 9999;
    const stops = flight.stops || 0;

    // Normalize scores (0-100, higher is better)
    const priceScore = maxPrice > minPrice ? 
      100 * (1 - (price - minPrice) / (maxPrice - minPrice)) : 50;
    
    const timeScore = maxDuration > minDuration ?
      100 * (1 - (duration - minDuration) / (maxDuration - minDuration)) : 50;
    
    const comfortScore = stops === 0 ? 100 : stops === 1 ? 70 : stops === 2 ? 40 : 20;

    // Apply user preference weights
    const weights = preferences.priorityWeights;
    const totalScore = (
      priceScore * weights.price +
      timeScore * weights.time +
      comfortScore * weights.comfort
    );

    return {
      total: Math.round(totalScore),
      breakdown: {
        price: Math.round(priceScore),
        time: Math.round(timeScore),
        comfort: Math.round(comfortScore)
      }
    };
  };

  // AI Explanation Engine - why this flight is recommended
  const generateFlightExplanation = async (flight, allFlights, searchParams) => {
    try {
      const score = scoreFlightMultiCriteria(flight, allFlights);
      const prompt = `You are a flight booking assistant. Explain in 1-2 sentences why this flight is a good choice.

Flight Details:
- Airline: ${flight.airline}
- Price: ${formatPrice(flight.price)}
- Duration: ${formatDuration(flight.duration)}
- Stops: ${flight.stops === 0 ? 'Direct' : `${flight.stops} stop(s)`}
- Departure: ${flight.depart.time}

Multi-Criteria Scores (out of 100):
- Price Score: ${score.breakdown.price}
- Time Score: ${score.breakdown.time}
- Comfort Score: ${score.breakdown.comfort}
- Overall Score: ${score.total}

Return a brief, friendly explanation focusing on the strongest aspects. Be specific about trade-offs if any.`;

      const response = await miyagiAPI.post('/generate-text', {
        prompt,
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_tokens: 100
      });

      if (response.success) {
        return response.data.text.trim();
      }
      return null;
    } catch (error) {
      console.error('Error generating explanation:', error);
      return null;
    }
  };

  const clearChat = () => {
    if (window.confirm('Clear chat history? (Search memory will be kept for context)')) {
      setMessages([]);
      setCurrentFlights([]);
      setSearchParams(null);
    }
  };
  
  const clearAllHistory = () => {
    if (window.confirm('Clear all history including search memory?')) {
      setMessages([]);
      setCurrentFlights([]);
      setSearchParams(null);
      setSearchHistory([]);
    }
  };

  const handleManualSearch = async (e) => {
    e.preventDefault();
    if (!manualForm.from || !manualForm.to || !manualForm.date || isProcessing) return;

    setIsProcessing(true);
    setShowManualForm(false);

    // Add to chat
    addMessage('user', `Search flights from ${manualForm.from} to ${manualForm.to} on ${manualForm.date}${manualForm.returnDate ? ` (return ${manualForm.returnDate})` : ''}`);
    addMessage('assistant', `🔍 Searching for flights from ${manualForm.from} to ${manualForm.to}...`);

    try {
      const flights = await searchFlights(manualForm);

      if (flights.length === 0) {
        addMessage('assistant', `No flights found for ${manualForm.from} → ${manualForm.to} on ${manualForm.date}.\n\nTips:\n• Use airport codes (e.g., "JFK", "LAX", "LHR")\n• Or full city names (e.g., "New York", "Los Angeles", "London")\n• Ensure the date is in the future`);
      } else {
        setCurrentFlights(flights);
        setSearchParams(manualForm);
        addMessage('assistant', `Found ${flights.length} flight options!`, { flights, params: manualForm });
      }
    } catch (error) {
      addMessage('assistant', `Error: ${error.message}`);
    }

    setIsProcessing(false);
  };

  if (!tailwindLoaded) {
    return <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>Loading...</div>;
  }

  return (
    <div style={{ 
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", sans-serif',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#ffffff'
    }}>
      {/* Header */}
      <div style={{
        padding: '32px 32px 24px 32px',
        borderBottom: '1px solid #f0f0f0'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ 
              fontSize: '28px', 
              fontWeight: '600', 
              color: '#000',
              margin: '0 0 8px 0',
              letterSpacing: '-0.02em'
            }}>
              AI Flight Assistant
            </h1>
            <p style={{ 
              fontSize: '14px', 
              color: '#666',
              margin: 0,
              fontWeight: '400'
            }}>
              Tell me where you want to go, and I'll find the best flights
            </p>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {searchHistory.length > 0 && (
              <div style={{
                padding: '8px 14px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: '8px',
                color: '#1e40af',
                fontSize: '13px',
                fontWeight: '500',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <span>🧠</span>
                <span>{searchHistory.length} search{searchHistory.length !== 1 ? 'es' : ''} in memory</span>
              </div>
            )}
            <button
              onClick={() => setShowManualForm(!showManualForm)}
              style={{
                padding: '10px 20px',
                background: showManualForm ? '#3B82F6' : 'transparent',
                border: '1px solid #f0f0f0',
                borderRadius: '8px',
                color: showManualForm ? '#ffffff' : '#666',
                fontSize: '14px',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={e => {
                if (!showManualForm) {
                  e.target.style.background = '#fafafa';
                  e.target.style.borderColor = '#e0e0e0';
                }
              }}
              onMouseLeave={e => {
                if (!showManualForm) {
                  e.target.style.background = 'transparent';
                  e.target.style.borderColor = '#f0f0f0';
                }
              }}
            >
              {showManualForm ? 'Hide Form' : 'Manual Search'}
            </button>
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                style={{
                  padding: '10px 20px',
                  background: 'transparent',
                  border: '1px solid #f0f0f0',
                  borderRadius: '8px',
                  color: '#666',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={e => {
                  e.target.style.background = '#fafafa';
                  e.target.style.borderColor = '#e0e0e0';
                }}
                onMouseLeave={e => {
                  e.target.style.background = 'transparent';
                  e.target.style.borderColor = '#f0f0f0';
                }}
              >
                Clear Chat
              </button>
            )}
            {searchHistory.length > 0 && (
              <button
                onClick={clearAllHistory}
                style={{
                  padding: '10px 20px',
                  background: 'transparent',
                  border: '1px solid #fee2e2',
                  borderRadius: '8px',
                  color: '#dc2626',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={e => {
                  e.target.style.background = '#fef2f2';
                  e.target.style.borderColor = '#fca5a5';
                }}
                onMouseLeave={e => {
                  e.target.style.background = 'transparent';
                  e.target.style.borderColor = '#fee2e2';
                }}
              >
                Clear All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div style={{ 
        flex: 1,
        overflowY: 'auto',
        padding: '32px'
      }}>
        {messages.length === 0 ? (
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            textAlign: 'center',
            padding: '40px'
          }}>
            <div style={{
              fontSize: '48px',
              marginBottom: '24px'
            }}>✈️</div>
            <h2 style={{
              fontSize: '20px',
              fontWeight: '600',
              color: '#000',
              margin: '0 0 12px 0'
            }}>AI Flight Assistant with Intelligence</h2>
            <p style={{
              fontSize: '15px',
              color: '#666',
              margin: '0 0 24px 0',
              lineHeight: '1.6',
              maxWidth: '600px'
            }}>
              Not just a search engine - I understand context, optimize for multiple criteria, and explain my recommendations.
            </p>
            
            {/* Unique Features */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '32px',
              maxWidth: '600px',
              width: '100%'
            }}>
              <div style={{
                background: '#eff6ff',
                padding: '16px',
                borderRadius: '12px',
                border: '1px solid #bfdbfe',
                textAlign: 'left'
              }}>
                <div style={{ fontSize: '20px', marginBottom: '8px' }}>🧠</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: '#1e40af', marginBottom: '4px' }}>
                  Smart Scoring
                </div>
                <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>
                  Balances price, time & comfort based on your priorities
                </div>
              </div>
              <div style={{
                background: '#f0fdf4',
                padding: '16px',
                borderRadius: '12px',
                border: '1px solid #bbf7d0',
                textAlign: 'left'
              }}>
                <div style={{ fontSize: '20px', marginBottom: '8px' }}>💬</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: '#166534', marginBottom: '4px' }}>
                  Remembers Context
                </div>
                <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>
                  Follow-up questions like "cheaper options" work seamlessly
                </div>
              </div>
              <div style={{
                background: '#fef3c7',
                padding: '16px',
                borderRadius: '12px',
                border: '1px solid #fde047',
                textAlign: 'left'
              }}>
                <div style={{ fontSize: '20px', marginBottom: '8px' }}>✨</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: '#92400e', marginBottom: '4px' }}>
                  AI Explanations
                </div>
                <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>
                  Understand WHY each flight is recommended
                </div>
              </div>
              <div style={{
                background: '#fce7f3',
                padding: '16px',
                borderRadius: '12px',
                border: '1px solid #fbcfe8',
                textAlign: 'left'
              }}>
                <div style={{ fontSize: '20px', marginBottom: '8px' }}>📊</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: '#9f1239', marginBottom: '4px' }}>
                  Visual Insights
                </div>
                <div style={{ fontSize: '13px', color: '#475569', lineHeight: '1.4' }}>
                  See trade-offs between price, time, and comfort at a glance
                </div>
              </div>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              alignItems: 'flex-start',
              background: '#fafafa',
              padding: '20px 28px',
              borderRadius: '12px',
              border: '1px solid #f0f0f0',
              maxWidth: '600px',
              width: '100%'
            }}>
              <div style={{ fontSize: '13px', fontWeight: '600', color: '#000', marginBottom: '4px' }}>
                Try these examples:
              </div>
              <div style={{ fontSize: '14px', color: '#666', fontStyle: 'italic' }}>
                "Find flights from JFK to LAX on 2026-03-15"
              </div>
              <div style={{ fontSize: '14px', color: '#666', fontStyle: 'italic' }}>
                "Show me flights to Paris tomorrow for 2 people"
              </div>
              <div style={{ fontSize: '14px', color: '#3B82F6', fontWeight: '500', marginTop: '8px' }}>
                Then try: "cheaper options" • "direct flights only" • "what about tomorrow?"
              </div>
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: '900px', margin: '0 auto' }}>
            {messages.map(msg => (
              <div key={msg.id} style={{ marginBottom: '24px' }}>
                {msg.role === 'user' ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{
                      background: '#3B82F6',
                      color: '#ffffff',
                      padding: '14px 20px',
                      borderRadius: '16px',
                      maxWidth: '70%',
                      fontSize: '15px',
                      lineHeight: '1.5',
                      fontWeight: '400'
                    }}>
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{
                      background: '#fafafa',
                      border: '1px solid #f0f0f0',
                      padding: '14px 20px',
                      borderRadius: '16px',
                      maxWidth: '70%',
                      fontSize: '15px',
                      lineHeight: '1.5',
                      color: '#000',
                      fontWeight: '400'
                    }}>
                      {msg.content}
                    </div>
                    
                    {/* Flight Results */}
                    {msg.flightData?.flights && (
                      <div style={{ marginTop: '20px' }}>
                        {msg.flightData.flights.slice(0, 10).map((flight, idx) => (
                          <div key={flight.id || idx} style={{
                            background: '#ffffff',
                            border: '1px solid #f0f0f0',
                            borderRadius: '12px',
                            padding: '24px',
                            marginBottom: '16px',
                            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.03)',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={e => {
                            e.currentTarget.style.boxShadow = '0 8px 30px rgba(0, 0, 0, 0.06)';
                            e.currentTarget.style.transform = 'translateY(-2px)';
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.03)';
                            e.currentTarget.style.transform = 'translateY(0)';
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <div style={{ flex: 1 }}>
                                {/* Airline */}
                                <div style={{
                                  fontSize: '16px',
                                  fontWeight: '600',
                                  color: '#000',
                                  marginBottom: '16px'
                                }}>
                                  {flight.airline || 'Multiple Airlines'}
                                  {flight.flightNumber && (
                                    <span style={{ 
                                      fontSize: '13px', 
                                      fontWeight: '500',
                                      color: '#666',
                                      marginLeft: '8px'
                                    }}>
                                      {flight.flightNumber}
                                    </span>
                                  )}
                                </div>

                                {/* Flight Times */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                                  <div>
                                    <div style={{ fontSize: '24px', fontWeight: '600', color: '#000' }}>
                                      {flight.depart.time || 'N/A'}
                                    </div>
                                    <div style={{ fontSize: '13px', color: '#666', marginTop: '4px' }}>
                                      {flight.depart.airport || 'N/A'}
                                    </div>
                                  </div>
                                  
                                  <div style={{ flex: 1, textAlign: 'center' }}>
                                    <div style={{ 
                                      fontSize: '12px', 
                                      color: '#666',
                                      marginBottom: '6px'
                                    }}>
                                      {formatDuration(flight.duration)}
                                    </div>
                                    <div style={{
                                      height: '2px',
                                      background: '#f0f0f0',
                                      position: 'relative'
                                    }}>
                                      <div style={{
                                        position: 'absolute',
                                        right: 0,
                                        top: '-3px',
                                        width: 0,
                                        height: 0,
                                        borderLeft: '6px solid #f0f0f0',
                                        borderTop: '4px solid transparent',
                                        borderBottom: '4px solid transparent'
                                      }}></div>
                                    </div>
                                    <div style={{ 
                                      fontSize: '12px', 
                                      color: '#666',
                                      marginTop: '6px'
                                    }}>
                                      {flight.stops === 0 ? 'Direct' : `${flight.stops} stop${flight.stops > 1 ? 's' : ''}`}
                                    </div>
                                  </div>

                                  <div>
                                    <div style={{ fontSize: '24px', fontWeight: '600', color: '#000' }}>
                                      {flight.arrive.time || 'N/A'}
                                    </div>
                                    <div style={{ fontSize: '13px', color: '#666', marginTop: '4px' }}>
                                      {flight.arrive.airport || 'N/A'}
                                    </div>
                                  </div>
                                </div>

                                {/* Multi-Criteria Scores */}
                                {flight.score && (
                                  <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #f0f0f0' }}>
                                    <div style={{ 
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '8px',
                                      marginBottom: '12px'
                                    }}>
                                      <span style={{ 
                                        fontSize: '13px', 
                                        fontWeight: '600',
                                        color: '#000'
                                      }}>
                                        Smart Score: {flight.score.total}/100
                                      </span>
                                      {idx === 0 && (
                                        <span style={{
                                          background: '#10b981',
                                          color: '#ffffff',
                                          padding: '2px 8px',
                                          borderRadius: '4px',
                                          fontSize: '11px',
                                          fontWeight: '600'
                                        }}>
                                          TOP PICK
                                        </span>
                                      )}
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                                      <div>
                                        <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>Price</div>
                                        <div style={{ 
                                          height: '6px', 
                                          background: '#f0f0f0', 
                                          borderRadius: '3px',
                                          overflow: 'hidden'
                                        }}>
                                          <div style={{
                                            height: '100%',
                                            width: `${flight.score.breakdown.price}%`,
                                            background: '#3B82F6',
                                            borderRadius: '3px',
                                            transition: 'width 0.3s'
                                          }}></div>
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                                          {flight.score.breakdown.price}/100
                                        </div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>Time</div>
                                        <div style={{ 
                                          height: '6px', 
                                          background: '#f0f0f0', 
                                          borderRadius: '3px',
                                          overflow: 'hidden'
                                        }}>
                                          <div style={{
                                            height: '100%',
                                            width: `${flight.score.breakdown.time}%`,
                                            background: '#8b5cf6',
                                            borderRadius: '3px',
                                            transition: 'width 0.3s'
                                          }}></div>
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                                          {flight.score.breakdown.time}/100
                                        </div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>Comfort</div>
                                        <div style={{ 
                                          height: '6px', 
                                          background: '#f0f0f0', 
                                          borderRadius: '3px',
                                          overflow: 'hidden'
                                        }}>
                                          <div style={{
                                            height: '100%',
                                            width: `${flight.score.breakdown.comfort}%`,
                                            background: '#10b981',
                                            borderRadius: '3px',
                                            transition: 'width 0.3s'
                                          }}></div>
                                        </div>
                                        <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                                          {flight.score.breakdown.comfort}/100
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Price and Book Button */}
                              <div style={{
                                marginLeft: '32px',
                                textAlign: 'right',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'flex-end',
                                justifyContent: 'space-between',
                                minHeight: '100px'
                              }}>
                                <div style={{
                                  fontSize: '28px',
                                  fontWeight: '700',
                                  color: '#3B82F6',
                                  marginBottom: '12px'
                                }}>
                                  {formatPrice(flight.price)}
                                </div>
                                {flight.url && (
                                  <a
                                    href={flight.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      padding: '12px 28px',
                                      background: '#3B82F6',
                                      color: '#ffffff',
                                      borderRadius: '10px',
                                      fontSize: '14px',
                                      fontWeight: '600',
                                      textDecoration: 'none',
                                      display: 'inline-block',
                                      cursor: 'pointer',
                                      transition: 'all 0.2s',
                                      boxShadow: '0 4px 12px rgba(59, 130, 246, 0.2)'
                                    }}
                                    onMouseEnter={e => {
                                      e.target.style.background = '#2563EB';
                                      e.target.style.transform = 'translateY(-1px)';
                                      e.target.style.boxShadow = '0 6px 16px rgba(59, 130, 246, 0.3)';
                                    }}
                                    onMouseLeave={e => {
                                      e.target.style.background = '#3B82F6';
                                      e.target.style.transform = 'translateY(0)';
                                      e.target.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.2)';
                                    }}
                                  >
                                    Book Now
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div style={{
        padding: '24px 32px 32px 32px',
        borderTop: '1px solid #f0f0f0',
        background: '#ffffff'
      }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          {/* Manual Search Form */}
          {showManualForm && (
            <form onSubmit={handleManualSearch} style={{ 
              marginBottom: '24px',
              padding: '24px',
              background: '#fafafa',
              borderRadius: '12px',
              border: '1px solid #f0f0f0'
            }}>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr',
                gap: '16px',
                marginBottom: '16px'
              }}>
                <div>
                  <label style={{ 
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#666',
                    marginBottom: '8px'
                  }}>From (airport/city)</label>
                  <input
                    type="text"
                    value={manualForm.from}
                    onChange={(e) => setManualForm({...manualForm, from: e.target.value})}
                    placeholder="e.g., JFK, New York"
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '8px',
                      outline: 'none',
                      background: '#ffffff',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>
                <div>
                  <label style={{ 
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#666',
                    marginBottom: '8px'
                  }}>To (airport/city)</label>
                  <input
                    type="text"
                    value={manualForm.to}
                    onChange={(e) => setManualForm({...manualForm, to: e.target.value})}
                    placeholder="e.g., LAX, Los Angeles"
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '8px',
                      outline: 'none',
                      background: '#ffffff',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>
              </div>
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr 100px',
                gap: '16px',
                marginBottom: '16px'
              }}>
                <div>
                  <label style={{ 
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#666',
                    marginBottom: '8px'
                  }}>Departure Date</label>
                  <input
                    type="date"
                    value={manualForm.date}
                    onChange={(e) => setManualForm({...manualForm, date: e.target.value})}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '8px',
                      outline: 'none',
                      background: '#ffffff',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>
                <div>
                  <label style={{ 
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#666',
                    marginBottom: '8px'
                  }}>Return Date (optional)</label>
                  <input
                    type="date"
                    value={manualForm.returnDate}
                    onChange={(e) => setManualForm({...manualForm, returnDate: e.target.value})}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '8px',
                      outline: 'none',
                      background: '#ffffff',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>
                <div>
                  <label style={{ 
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '500',
                    color: '#666',
                    marginBottom: '8px'
                  }}>Adults</label>
                  <input
                    type="number"
                    min="1"
                    max="9"
                    value={manualForm.adults}
                    onChange={(e) => setManualForm({...manualForm, adults: parseInt(e.target.value)})}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      border: '1px solid #f0f0f0',
                      borderRadius: '8px',
                      outline: 'none',
                      background: '#ffffff',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={!manualForm.from || !manualForm.to || !manualForm.date || isProcessing}
                style={{
                  width: '100%',
                  padding: '14px',
                  background: (!manualForm.from || !manualForm.to || !manualForm.date || isProcessing) ? '#e0e0e0' : '#3B82F6',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: (!manualForm.from || !manualForm.to || !manualForm.date || isProcessing) ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={e => {
                  if (manualForm.from && manualForm.to && manualForm.date && !isProcessing) {
                    e.target.style.background = '#2563EB';
                  }
                }}
                onMouseLeave={e => {
                  if (manualForm.from && manualForm.to && manualForm.date && !isProcessing) {
                    e.target.style.background = '#3B82F6';
                  }
                }}
              >
                {isProcessing ? 'Searching...' : 'Search Flights'}
              </button>
            </form>
          )}

          {/* Natural Language Input */}
          <form onSubmit={handleSubmit}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder="Describe your flight needs... (e.g., 'JFK to LAX on 2026-03-15')"
                disabled={isProcessing}
                style={{
                  width: '100%',
                  padding: '18px 120px 18px 24px',
                  fontSize: '15px',
                  border: '1px solid #f0f0f0',
                  borderRadius: '12px',
                  outline: 'none',
                  fontFamily: 'inherit',
                  background: '#fafafa',
                  color: '#000',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)'
                }}
                onFocus={e => {
                  e.target.style.borderColor = '#3B82F6';
                  e.target.style.background = '#ffffff';
                  e.target.style.boxShadow = '0 4px 16px rgba(59, 130, 246, 0.1)';
                }}
                onBlur={e => {
                  e.target.style.borderColor = '#f0f0f0';
                  e.target.style.background = '#fafafa';
                  e.target.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.02)';
                }}
              />
              <button
                type="submit"
                disabled={isProcessing || !userInput.trim()}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  padding: '10px 24px',
                  background: isProcessing || !userInput.trim() ? '#e0e0e0' : '#3B82F6',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: isProcessing || !userInput.trim() ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  boxShadow: isProcessing || !userInput.trim() ? 'none' : '0 2px 8px rgba(59, 130, 246, 0.2)'
                }}
                onMouseEnter={e => {
                  if (!isProcessing && userInput.trim()) {
                    e.target.style.background = '#2563EB';
                    e.target.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.3)';
                  }
                }}
                onMouseLeave={e => {
                  if (!isProcessing && userInput.trim()) {
                    e.target.style.background = '#3B82F6';
                    e.target.style.boxShadow = '0 2px 8px rgba(59, 130, 246, 0.2)';
                  }
                }}
              >
                {isProcessing ? 'Searching...' : 'Search'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default AiFlightAgent;
