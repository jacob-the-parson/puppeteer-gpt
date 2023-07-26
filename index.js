"use strict";

import fs from 'fs';
import puppeteer, { TimeoutError } from 'puppeteer';
import cheerio from 'cheerio';
import readline from 'readline';

const debug = in_array( "--debug", process.argv );
const autopilot = in_array( "--autopilot", process.argv ); // for gpt-autopilot

let model = "gpt-3.5-turbo-16k";
if( in_array( "--model", process.argv ) ) {
    model = process.argv[parseInt(process.argv.indexOf("--model"))+1];
}

let context_length_limit = 6000;
if( in_array( "--limit", process.argv ) ) {
    context_length_limit = process.argv[parseInt(process.argv.indexOf("--limit"))+1];
}

let navigation_timeout = 15000;
if( in_array( "--timeout", process.argv ) ) {
    navigation_timeout = parseInt( process.argv[parseInt(process.argv.indexOf("--timeout"))+1] );
}

let wait_until = "networkidle0";
if( in_array( "--waituntil", process.argv ) ) {
    wait_until = process.argv[parseInt(process.argv.indexOf("--waituntil"))+1];
}

let headless = true;
if( in_array( "--headless", process.argv ) ) {
    headless = (process.argv[parseInt(process.argv.indexOf("--headless"))+1] ?? "true") !== "false";
}

let token_usage = {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
};

function get_token_price( model, direction ) {
    let token_price_input = 0.0
    let token_price_output = 0.0

    if( model.indexOf("gpt-4-32k") === 0 ) {
        token_price_input = 0.06 / 1000
        token_price_output = 0.12 / 1000
    } else if( model.indexOf("gpt-4") === 0 ) {
        token_price_input = 0.03 / 1000
        token_price_output = 0.06 / 1000
    } else if( model.indexOf("gpt-3.5-turbo-16k") === 0 ) {
        token_price_input = 0.003 / 1000
        token_price_output = 0.004 / 1000
    } else if( model.indexOf("gpt-3.5-turbo") === 0 ) {
        token_price_input = 0.0015 / 1000
        token_price_output = 0.002 / 1000
    }

    if( direction == "input" ) {
        return token_price_input
    } else {
        return token_price_output
    }
}

function token_cost( prompt_tokens, completion_tokens, model ) {
    let prompt_price = get_token_price( model, "input" );
    let completion_price = get_token_price( model, "output" );

    return prompt_tokens * prompt_price + completion_tokens * completion_price;
}

function round( number, decimals ) {
    return number.toFixed( decimals );
}

function print_current_cost() {
    let cost = token_cost(
        token_usage.prompt_tokens,
        token_usage.completion_tokens,
        model,
    );

    print( "Current cost: " + round( cost, 2 ) + " USD (" + token_usage.total_tokens + " tokens)" );
}

function print( message = "" ) {
    console.log( message );
}

function in_array( element, array ) {
    for( let i = 0; i < array.length; i++ ) {
        if( array[i] == element ) {
            return true;
        }
    }

    return false;
}

async function input( text ) {
    let the_prompt;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await (async () => {
        return new Promise( resolve => {
            rl.question( text, (prompt) => {
                the_prompt = prompt;
                rl.close();
                resolve();
            } );
        } );
    })();

    return the_prompt;
}

print( "Using model: " + model + "\n" )

let the_prompt;
if( autopilot ) {
    the_prompt = await input( "<!_PROMPT_!>\n" );
} else {
    the_prompt = await input( "GPT: Hello! What would you like to browse today?\nYou: " )
    print();
}

const openaiApiKey = process.env.OPENAI_API_KEY;

function good_html( html ) {
    html = html.replace(/<\//g, ' </');
    let $ = cheerio.load( html );

    $("script, style").remove();

    let important = [
        'main',
        '[role="main"]',
        '#bodyContent',
        '#search',
        '.kp-header',
    ];

    // move important content to top
    important.forEach((im) => {
        $(im).each((i, el) => {
            $(el).prependTo("body");
        });
    });

    return $;
}

function ugly_chowder( html ) {
    let $ = good_html( html );

    let simpledata = "";

    const important = [
        ".kp-header",
        "#search",
    ];

    // always get textcontent of important stuff
    important.forEach((im) => {
        $(im).each((i, el) => {
            simpledata += $(el).text() + "\n\n";
        });
    });

    const allowed_tags = [
        "h1",
        "h2",
        "h3",
        "p",
        "time",
        "article",
        "a",
        "ul",
        "ol",
        "li",
    ];

    const allowed_attrs = [
        "datetime",
        "data-testid",
    ];

    $('*').each((i, el) => {
        const tag = $(el).prop('name');

        if( in_array( tag, allowed_tags ) ) {
            const text = $(el).text().replace(/[\s\n]+/g, ' ') + " ";
            const attrs = $(el).attr();
            const attrString = Object.keys(attrs).map(key => {
                return in_array( key, allowed_attrs ) ? ` ${key}="${attrs[key]}"` : '';
            }).join('');
            simpledata += ` <${tag}${attrString}>${text}`;
        }
    });

    return simpledata;
};

function redact_messages( messages ) {
    let redacted_messages = [];

    messages.forEach( (message) => {
        let msg = {
            "role": message.role,
            "content": message.redacted ?? message.content ?? "",
        };
        if( message.name ) {
            msg.name = message.name;
        }
        redacted_messages.push(msg);
    } );

    return redacted_messages;
}

async function send_chat_message( message, context ) {
    let messages = [...context];
    messages.push( message );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( messages, null, 2 ) );
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        "model": model,
        "messages": redact_messages( messages ),
        "functions": [
            {
                "name": "goto_url",
                "description": "Goes to a specific URL",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        },
                        "url": {
                            "type": "string",
                            "description": "The URL to go to (including protocol)"
                        }
                    }
                },
                "required": ["reasoning", "url"]
            },
            {
                "name": "list_links",
                "description": "Gets a list of the links on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        }
                    }
                },
                "required": ["reasoning"]
            },
            {
                "name": "list_inputs",
                "description": "Gets a list of the input fields on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        }
                    }
                },
                "required": ["reasoning"]
            },
            {
                "name": "click_link",
                "description": "Clicks a specific link on the page (list_links must be called first)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        },
                        "link_id": {
                            "type": "number",
                            "description": "The ID number of the link to click"
                        }
                    }
                },
                "required": ["reasoning", "link_id"]
            },
            {
                "name": "type_text",
                "description": "Types some text to an input field (list_inputs must be called first)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        },
                        "input_id": {
                            "type": "number",
                            "description": "The ID number of the input to type into"
                        },
                        "text": {
                            "type": "string",
                            "description": "The text to type"
                        }
                    }
                },
                "required": ["reasoning", "input_id", "text"]
            },
            {
                "name": "send_form",
                "description": "Sends the form that the last filled input field belongs to",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        }
                    }
                },
                "required": ["reasoning"]
            },
            {
                "name": "get_content",
                "description": "Gets the text content on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explanation on why you would like to run this function."
                        }
                    }
                },
                "required": ["reasoning"]
            },
            {
                "name": "answer_user",
                "description": "Give an answer to the user and end the navigation",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "answer": {
                            "type": "string",
                            "description": "The response to the user"
                        }
                    }
                },
                "required": ["answer"]
            },
        ],
        "function_call": "auto"
      })
    }).catch(function(e) {
        print(e);
    });

    const data = await response.json();

    if( data.choices === undefined ) {
        print( data );
    }

    token_usage.completion_tokens += data.usage.completion_tokens;
    token_usage.prompt_tokens += data.usage.prompt_tokens;
    token_usage.total_tokens += data.usage.total_tokens;

    let cost = token_cost(
        data.usage.prompt_tokens,
        data.usage.completion_tokens,
        model,
    );

    if( cost > 0.09 ) {
        print( "Cost: +" + round( cost, 2 ) + " USD (+" + data.usage.total_tokens + " tokens)" );
    }

    if( autopilot ) {
        print( "<!_TOKENS_!>" + data.usage.prompt_tokens + " " + data.usage.completion_tokens + " " + data.usage.total_tokens )
    }

    return data.choices[0].message;
}

async function sleep( ms ) {
    return new Promise( (resolve) => setTimeout( resolve, ms ) );
}

let page_loaded = false;
let request_count = 0;

(async () => {
    const browser = await puppeteer.launch({
        headless: headless ? "new" : false
    });

    const page = await browser.newPage();

    page.on( 'request', () => {
        request_count++;
    } );

    page.on( 'load', () => {
        page_loaded = true;
    } );

    page.on( 'framenavigated', () => {
        page_loaded = false;
    } );

    let context = [
        {
            "role": "system",
            "content": `You have been tasked with crawling the internet based on a task given by the user. You are connected to a Puppeteer script that can navigate to pages and list elements on the page. You can also type into search boxes and other input fields and send forms. You can also click links on the page. If you encounter a Page Not Found error, try another URL or try going to the front page of the site and navigating from there. If the page doesn't have the content you want, try clicking on a link or navigating to a completely different page. You must list the links or the inputs first before you can click on them or input into them. If you use Google, note that the links in the results will point to URLs outside Google (don't click on search suggestions etc.). Avoid direct URLs that might have expired or be invalid.`
        }
    ];

    let message = `Task: ${the_prompt}`;
    let msg = {
        role: "user",
        content: message
    }

    let response = await send_chat_message(
        msg,
        context
    );

    context.push(msg);

    context.push(response);

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    await do_next_step( page, context, response, [], [], null );

    browser.close();
})();

async function list_links( page ) {
    const clickableElements = await page.$$('a, button');

    let links = [];
    let nav_links = [];
    let number = 0;

    for (const element of clickableElements) {
        number++;

        const href = await element.evaluate( (e) => e.href );
        let textContent = await element.evaluate( (e) => e.textContent );
        textContent = textContent.replace(/\n/g, '').trim();

        let duplicate_link = links.find( elem => {
            elem.text == textContent && href && elem.href == href
        } );

        if( textContent && ! duplicate_link ) {
            let link = {
                id: number,
                element: element,
                text: textContent,
                url: href,
            }

            const is_in_nav = await element.evaluate( (node) => {
                const closest_nav = node.closest('nav');
                return closest_nav !== null;
            } );

            if( is_in_nav ) {
                nav_links.push( link );
            } else {
                links.push( link );
            }
        }
    }

    return [...links, ...nav_links];
}

async function list_inputs( page ) {
    const clickableElements = await page.$$('input, textarea');

    let inputs = [];
    let number = 0;

    for (const element of clickableElements) {
        number++;

        const type = await element.evaluate( (e) => e.type );
        const name = await element.evaluate( (e) => e.name );
        const role = await element.evaluate( (e) => e.role );
        const placeholder = await element.evaluate( (e) => e.placeholder );
        const title = await element.evaluate( (e) => e.title );

        let text = "";

        if( name && type != "hidden" ) {
            text += name;
            if( type ) {
                text += " (type: " + type + ")";
            }
            if( role ) {
                text += " (role: " + role + ")";
            }
            if( placeholder ) {
                text += " (placeholder: " + placeholder + ")";
            }
            if( title ) {
                text += " (title: " + title + ")";
            }

            if( ! inputs.find( elem => elem.text == text ) ) {
                let input = {
                    id: number,
                    element: element,
                    text: text
                }

                inputs.push( input );
            }
        }
    }

    return inputs;
}

function list_for_gpt( list, what ) {
    let formatted = JSON.parse( JSON.stringify( list ) );

    for( const element of formatted ) {
        delete element.element;
    }

    return JSON.stringify( formatted, null, 2 );
}

function check_download_error( error ) {
    if( error instanceof Error && error.message.startsWith('net::ERR_ABORTED') ) {
        return "NOTICE: The connection was aborted. If you clicked on a download link, the file has been downloaded to the default Chrome downloads location.";
    } else if( debug ) {
        print( error );
    }

    return null;
}

async function wait_for_navigation() {
    if( page_loaded === true ) {
        return false;
    }

    let wait_time = 0;
    while( page_loaded === false && wait_time < navigation_timeout ) {
        await sleep( 500 );
        wait_time += 500;
    }

    return true;
}

async function do_next_step( page, context, next_step, links, inputs, element ) {
    let message;
    let msg;
    let redacted_message;

    let task_prefix = "";
    if( autopilot ) {
        task_prefix = "<!_TASK_!>";
    }

    if( next_step.hasOwnProperty( "function_call" ) ) {
        let function_call = next_step.function_call;
        let function_name = function_call.name;
        let func_arguments;

        try {
            func_arguments = JSON.parse(function_call.arguments);
        } catch( e ) {
            if( function_name === "answer_user" ) {
                func_arguments = {
                    "answer": function_call.arguments
                }
            }
        }

        if( function_name === "goto_url" ) {
            let url = func_arguments.url;

            print( task_prefix + "Going to " + url );

            try {
                await page.goto( url, {
                    waitUntil: wait_until
                } );

                await sleep( 3000 );

                url = await page.url();

                links = false;

                message = `I'm on ${url} now. What should I do next? Call list_links to get a list of the links on the page. Call list_inputs to list all the input fields on the page. Call get_content to get the text content of the page.`
            } catch( error ) {
                message = check_download_error( error );
                message = message ?? "There was an error going to the URL";
            }
        } else if( function_name === "list_links" ) {
            print( task_prefix + "Listing links" );

            let url = await page.url();

            links = await list_links( page );
            let links_for_gpt = list_for_gpt( links, "Link" );
            if( links.length ) {
                message = `Here is the list of links on the page. Please call "list_inputs" if you want to see the list of the inputs instead or call "click_link" with the ID number of a link to click it.\n\nRemember your task: ${the_prompt}\n\nRemember you have already navigated to ${url}`;
            } else {
                message = "There are no links on the page.";
            }
            redacted_message = message;
            message += "\n\n" + links_for_gpt;
            if( links.length ) {
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "list_inputs" ) {
            print( task_prefix + "Listing inputs" );

            inputs = await list_inputs( page );
            let inputs_for_gpt = list_for_gpt( inputs, "input" );
            if( inputs.length ) {
                message = `Here is the list of inputs on the page. Please call "list_links" if you want to see the list of the links instead or call "type_text" with the ID number of the input field and the text to type.`;
            } else {
                message = `There are no inputs on the page.`;
            }
            redacted_message = message;
            message += "\n\n" + inputs_for_gpt;
            if( inputs.length ) {
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "click_link" ) {
            let link_id = func_arguments.link_id;

            if( links === false ) {
                message = "ERROR: You must first list the links to get the IDs";
            } else {
                const link = links.find( elem => elem.id == link_id );

                try {
                    element = link.element;

                    print( task_prefix + `Clicking link "${link.text}"` );

                    request_count = 0;
                    await element.click();
                    await sleep( 300 );

                    if( await wait_for_navigation() ) {
                        await sleep( 3000 );
                        let url = await page.url();
                        message = `I'm on ${url} now. What should I do next? Please call "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also call "get_content" to get the content of the page.`
                    } else {
                        message = "Link successfully clicked!";
                        if( request_count > 0 ) {
                            message += " If this was a download link, the download has been started to the Chrome default downloads folder.";
                        }
                    }

                    links = false;
                } catch( error ) {
                    if( error instanceof TimeoutError ) {
                        message = "NOTICE: The click did not cause a navigation. If it was a download link, the file has been downloaded to the default Chrome download location.";
                    } else {
                        links = await list_links( page );
                        let links_for_gpt = list_for_gpt( links, "link" );

                        let link_text = link ? link.text : "";

                        message = `Sorry, but link number ${link_id} (${link_text}) is not clickable, please select another link or another command. You can also try to go to the link URL directly with "goto_url". You can also call "get_content" to get the content of the page. Here's the list of links again:`
                        redacted_message = message;
                        message += "\n\n" + links_for_gpt;
                        redacted_message += "\n\n<list redacted>";
                    }
                }
            }
        } else if( function_name === "type_text" ) {
            let element_id = func_arguments.input_id;
            let text = func_arguments.text;

            try {
                const input = inputs.find( elem => elem.id == element_id );
                element = input.element;

                await element.type( text );

                print( task_prefix + `Typing "${JSON.stringify(text)}" to an input field` );

                message = `OK. I typed "${text}" to the input box ${element_id}. What should I do next? Please call "send_form" if you want to submit the form.`;
            } catch( error ) {
                message = `Sorry, but there was an error with that command. Please try another command.`
            }
        } else if( function_name === "send_form" ) {
            let navigation = "";

            const form = await element.evaluateHandle(
                input => input.closest('form')
            );

            print( task_prefix + `Submitting form` );

            await form.evaluate(form => form.submit());

            let navigated = "No navigation occured.";
            if( await wait_for_navigation() ) {
                await sleep( 3000 );
                navigated = "";
            }

            let url = await page.url();

            links = false;

            message = `OK. I sent the form. I'm on ${url} now. ${navigated} What should I do next? Please call "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also call "get_content" to get the content of the page.`
        } else if( function_name === "get_content" ) {
            links = false;

            print( task_prefix + "Getting page content" );

            const html = await page.evaluate(() => {
                return document.body.innerHTML;
            });

            const pageContent = ugly_chowder( html );

            message = `Here's the current page content. Please call "list_links" or "list_inputs" to get their ID's or call the next function.`;
            redacted_message = message;
            message += "\n\n## CONTENT START ##\n" + pageContent + "\n## CONTENT END ##\n\nPlease call the next function or the 'answer_user' function if the user's task has been completed.";
            redacted_message += "\n\n<content redacted>";
        } else if( function_name === "answer_user" ) {
            let text = func_arguments.answer;

            let url = await page.url();
            text = text.replace( "[url]", url );
            text = text.replace( "[/url]", "" );

            print_current_cost();

            if( autopilot ) {
                message = await input( "<!_RESPONSE_!>" + JSON.stringify(text) + "\n" );
            } else{
                message = await input( "\nGPT: " + text + "\nYou: " );
            }

            print();
        } else {
            message = "That is an unknown function. Please call another one";
        }

        message = message.substring( 0, context_length_limit );
        msg = {
            "role": "function",
            "name": function_name,
            "content": message,
        }
    } else {
        print_current_cost();

        let next_content = next_step.content.trim();

        if( next_content == "" ) {
            message = "Please continue the task or call answer_user"
        } else {
            if( autopilot ) {
                message = await input( "<!_RESPONSE_!>" + JSON.stringify(next_content) + "\n" );
            } else{
                message = await input( "GPT: " + next_content + "\nYou: " );
                print();
            }
        }

        msg = {
            "role": "user",
            "content": message,
        }
    }

    next_step = await send_chat_message( msg, context );

    msg.redacted = redacted_message;

    context.push( msg );
    context.push( next_step );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    await do_next_step( page, context, next_step, links, inputs, element );
}
